require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const orders = require('./lib/orders');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const samplePOs = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sample-pos.json'), 'utf8'));

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
  return orders.inventory.map(i => `${i.sku} :: ${i.description} (unit: ${i.unit})`).join('\n');
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
    const order = orders.createOrder(text, extracted);

    res.json({
      id: order.id,
      status: order.status,
      extracted,
      invoice: order.invoice,
      exceptions: order.exceptions,
      draftEmail: order.draftEmail,
      autoProcessedCount: order.autoProcessedCount,
      totalLineCount: order.totalLineCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong processing the PO.' });
  }
});

function handle(fn) {
  return (req, res) => {
    try {
      res.json(fn(req));
    } catch (err) {
      if (err instanceof orders.OrderError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error(err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  };
}

app.get('/api/orders', handle(() => orders.listOrders()));
app.get('/api/stats', handle(() => orders.computeStats()));
app.get('/api/inventory', handle(() => orders.inventory));
app.get('/api/customers', handle(() => orders.allCustomers()));
app.get('/api/orders/:id', handle(req => orders.getOrder(req.params.id)));

app.post('/api/orders/:id/lines/:index', handle(req =>
  orders.updateLine(req.params.id, Number(req.params.index), req.body || {})
));
app.post('/api/orders/:id/customer', handle(req =>
  orders.setCustomer(req.params.id, req.body || {})
));
app.post('/api/orders/:id/send', handle(req =>
  orders.sendOrder(req.params.id, (req.body || {}).email)
));
app.post('/api/demo/reset', handle(() => {
  orders.seedOrders();
  return { ok: true };
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Back-Office Employee demo running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. Create a .env file (see .env.example) before processing a PO.');
  }
});
