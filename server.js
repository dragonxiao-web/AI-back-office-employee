require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'inventory.json'), 'utf8'));
const customers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'customers.json'), 'utf8'));
const samplePOs = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sample-pos.json'), 'utf8'));

const VAT_RATE = 0.12;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/api/samples', (req, res) => {
  res.json(samplePOs);
});

const EXTRACT_TOOL = {
  name: 'extract_purchase_order',
  description: 'Extract structured data from a raw purchase order email/text, matching each line item to the closest SKU in the provided inventory catalog.',
  input_schema: {
    type: 'object',
    properties: {
      poNumber: { type: 'string', description: 'PO number if present, else empty string' },
      customerNameGuess: { type: 'string', description: 'Customer/company name as best guessed from the text' },
      customerEmailGuess: { type: 'string', description: 'Sender email address if present, else empty string' },
      deliveryNotes: { type: 'string', description: 'Any delivery/urgency notes, else empty string' },
      lineItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rawText: { type: 'string', description: 'The original line as written in the PO' },
            description: { type: 'string', description: 'Cleaned-up description of the item' },
            quantity: { type: 'number' },
            unit: { type: 'string', description: 'Unit of measure as written, e.g. pcs, bags, rolls' },
            matchedSku: {
              type: 'string',
              description: 'The SKU from the inventory catalog that best matches this item, or empty string if no confident match exists'
            },
            matchConfidence: {
              type: 'string',
              enum: ['high', 'medium', 'low', 'none'],
              description: 'How confident the match to matchedSku is. Use "none" if matchedSku is empty.'
            }
          },
          required: ['rawText', 'description', 'quantity', 'unit', 'matchedSku', 'matchConfidence']
        }
      }
    },
    required: ['poNumber', 'customerNameGuess', 'customerEmailGuess', 'deliveryNotes', 'lineItems']
  }
};

function buildCatalogText() {
  return inventory.map(i => `${i.sku} :: ${i.description} (unit: ${i.unit})`).join('\n');
}

function matchCustomer(nameGuess, emailGuess) {
  const emailDomain = (emailGuess || '').split('@')[1];
  let match = customers.find(c => emailDomain && c.email.split('@')[1] === emailDomain);
  if (!match && nameGuess) {
    const lower = nameGuess.toLowerCase();
    match = customers.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase().split(' ')[0]));
  }
  return match || null;
}

app.post('/api/process-po', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'No PO text provided.' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in a .env file and restart the server.' });
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: `You are the data-extraction module of an AI back-office employee at a construction/hardware distributor. You are given a raw purchase order email and a product catalog. Extract the PO into structured data and match each requested item to the closest catalog SKU. Only assign matchConfidence "high" or "medium" when you are genuinely confident the item refers to the same product (e.g. "rebar 10mm" matches "REBAR-10MM"). If an item has no reasonable match in the catalog (e.g. it's a product the company doesn't sell), leave matchedSku empty and set matchConfidence to "none" — do not force a match.\n\nProduct catalog:\n${buildCatalogText()}`,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_purchase_order' },
      messages: [{ role: 'user', content: text }]
    });

    const toolUse = message.content.find(b => b.type === 'tool_use');
    if (!toolUse) {
      return res.status(502).json({ error: 'AI did not return structured data. Try again.' });
    }
    const extracted = toolUse.input;

    const exceptions = [];
    const invoiceLines = [];

    for (const item of extracted.lineItems) {
      const invLine = {
        rawText: item.rawText,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        matchedSku: item.matchedSku || null,
        matchConfidence: item.matchConfidence,
        status: 'ok'
      };

      if (!item.matchedSku || item.matchConfidence === 'none' || item.matchConfidence === 'low') {
        invLine.status = 'unrecognized';
        exceptions.push({
          type: 'unrecognized_item',
          message: `"${item.rawText}" could not be confidently matched to a catalog item — needs manual lookup.`
        });
      } else {
        const invRecord = inventory.find(i => i.sku === item.matchedSku);
        if (!invRecord) {
          invLine.status = 'unrecognized';
          exceptions.push({
            type: 'unrecognized_item',
            message: `AI referenced SKU "${item.matchedSku}" which isn't in the catalog — needs manual lookup.`
          });
        } else {
          invLine.unitPrice = invRecord.unitPrice;
          invLine.qtyOnHand = invRecord.qtyOnHand;
          invLine.extendedPrice = round2(invRecord.unitPrice * item.quantity);
          if (item.quantity > invRecord.qtyOnHand) {
            invLine.status = 'insufficient_stock';
            exceptions.push({
              type: 'insufficient_stock',
              message: `Only ${invRecord.qtyOnHand} ${invRecord.unit}(s) of "${invRecord.description}" in stock, but ${item.quantity} were ordered — needs manual decision (partial ship / backorder / substitute).`
            });
          }
        }
      }
      invoiceLines.push(invLine);
    }

    const customer = matchCustomer(extracted.customerNameGuess, extracted.customerEmailGuess);
    if (!customer) {
      exceptions.push({
        type: 'unknown_customer',
        message: `Could not match "${extracted.customerNameGuess || '(no name found)'}" to an existing customer account — needs manual verification before invoicing.`
      });
    }

    const billableLines = invoiceLines.filter(l => l.status === 'ok' || l.status === 'insufficient_stock');
    const subtotal = round2(billableLines.reduce((sum, l) => sum + (l.extendedPrice || 0), 0));
    const vat = round2(subtotal * VAT_RATE);
    const total = round2(subtotal + vat);

    const invoiceNumber = 'INV-' + Date.now().toString().slice(-8);
    const invoice = {
      invoiceNumber,
      poNumber: extracted.poNumber || '(none provided)',
      customer: customer || { name: extracted.customerNameGuess || 'Unknown customer', email: extracted.customerEmailGuess || '', terms: 'TBD — verify' },
      lines: invoiceLines,
      subtotal,
      vat,
      vatRate: VAT_RATE,
      total,
      date: new Date().toISOString().slice(0, 10)
    };

    const draftEmail = buildDraftEmail(invoice, exceptions);

    res.json({
      extracted,
      invoice,
      exceptions,
      draftEmail,
      autoProcessedCount: invoiceLines.filter(l => l.status === 'ok').length,
      totalLineCount: invoiceLines.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong processing the PO.' });
  }
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function buildDraftEmail(invoice, exceptions) {
  const okLines = invoice.lines.filter(l => l.status === 'ok' || l.status === 'insufficient_stock');
  const itemRows = okLines.map(l =>
    `  - ${l.description} x ${l.quantity} ${l.unit} @ PHP ${l.unitPrice.toFixed(2)} = PHP ${l.extendedPrice.toFixed(2)}${l.status === 'insufficient_stock' ? '  [PARTIAL/BACKORDER - see note]' : ''}`
  ).join('\n');

  let body = `Subject: Invoice ${invoice.invoiceNumber} for PO ${invoice.poNumber}\n\n`;
  body += `Hi ${invoice.customer.name},\n\n`;
  body += `Thank you for your order. Here is a summary of what we can confirm so far:\n\n`;
  body += itemRows + '\n\n';
  body += `Subtotal: PHP ${invoice.subtotal.toFixed(2)}\n`;
  body += `VAT (${(invoice.vatRate * 100).toFixed(0)}%): PHP ${invoice.vat.toFixed(2)}\n`;
  body += `Total: PHP ${invoice.total.toFixed(2)}\n`;
  body += `Terms: ${invoice.customer.terms}\n\n`;
  if (exceptions.length > 0) {
    body += `A couple of items on your order need a quick check from our team before we can finalize everything (see below) — someone will follow up shortly.\n\n`;
  }
  body += `Best regards,\n[Your Company Name]`;
  return body;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Back-Office Employee demo running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. Create a .env file (see .env.example) before processing a PO.');
  }
});
