const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const inventory = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'inventory.json'), 'utf8'));
const baseCustomers = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'customers.json'), 'utf8'));

const VAT_RATE = 0.12;
const MANUAL_MINUTES_PER_PO = 15;
const STAFF_MINUTES_UNTOUCHED = 1;
const STAFF_MINUTES_WITH_EXCEPTIONS = 5;

class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

let store = { nextSeq: 1001, orders: [], extraCustomers: [] };

function round2(n) {
  return Math.round(n * 100) / 100;
}

function money(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function allCustomers() {
  return [...baseCustomers, ...store.extraCustomers];
}

function matchCustomer(nameGuess, emailGuess) {
  const customers = allCustomers();
  const emailDomain = (emailGuess || '').split('@')[1];
  let match = customers.find(c => emailDomain && c.email.split('@')[1] === emailDomain);
  if (!match && nameGuess) {
    const lower = nameGuess.toLowerCase();
    match = customers.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase().split(' ')[0]));
  }
  return match || null;
}

function evaluate(order) {
  const exceptions = [];

  order.lines.forEach((line, i) => {
    for (const k of ['unitPrice', 'qtyOnHand', 'catalogDescription', 'extendedPrice', 'shipQty', 'backorderQty', 'billedQty']) {
      delete line[k];
    }

    if (line.removed) {
      line.status = 'removed';
      return;
    }

    const confident = line.matchedSku && ['high', 'medium', 'manual'].includes(line.matchConfidence);
    const rec = confident ? inventory.find(r => r.sku === line.matchedSku) : null;

    if (!rec) {
      line.status = 'unrecognized';
      exceptions.push({
        type: 'unrecognized_item',
        lineIndex: i,
        message: `"${line.rawText}" could not be confidently matched to a catalog item — needs manual lookup.`
      });
      return;
    }

    line.unitPrice = rec.unitPrice;
    line.qtyOnHand = rec.qtyOnHand;
    line.catalogDescription = rec.description;
    const qty = line.quantity;

    if (qty > rec.qtyOnHand) {
      if (line.stockResolution === 'ship_available') {
        line.status = 'partial';
        line.shipQty = rec.qtyOnHand;
        line.backorderQty = qty - rec.qtyOnHand;
        line.billedQty = line.shipQty;
      } else if (line.stockResolution === 'backorder_all') {
        line.status = 'backordered';
        line.shipQty = 0;
        line.backorderQty = qty;
        line.billedQty = 0;
      } else {
        line.status = 'insufficient_stock';
        line.billedQty = qty;
        exceptions.push({
          type: 'insufficient_stock',
          lineIndex: i,
          message: `Only ${rec.qtyOnHand} ${rec.unit}(s) of "${rec.description}" in stock, but ${qty} were ordered — needs a decision: ship what's on hand now, or backorder the full quantity.`
        });
      }
    } else {
      line.status = 'ok';
      line.billedQty = qty;
    }
    line.extendedPrice = round2(rec.unitPrice * line.billedQty);
  });

  if (!order.customer) {
    exceptions.push({
      type: 'unknown_customer',
      message: `Could not match "${order.customerNameGuess || '(no name found)'}" to an existing customer account — needs manual verification before invoicing.`
    });
  }

  const subtotal = round2(order.lines.reduce((sum, l) => sum + (l.extendedPrice || 0), 0));
  const vat = round2(subtotal * VAT_RATE);

  order.exceptions = exceptions;
  order.invoice = {
    invoiceNumber: order.invoiceNumber,
    poNumber: order.poNumber || '(none provided)',
    customer: order.customer || {
      name: order.customerNameGuess || 'Unknown customer',
      email: order.customerEmailGuess || '',
      terms: 'TBD — verify'
    },
    lines: order.lines,
    subtotal,
    vat,
    vatRate: VAT_RATE,
    total: round2(subtotal + vat),
    date: order.createdAt.slice(0, 10)
  };

  if (order.status !== 'sent') {
    order.status = exceptions.length ? 'needs_review' : 'ready';
    order.draftEmail = buildDraftEmail(order);
  }
}

function buildDraftEmail(order) {
  const inv = order.invoice;
  const rows = [];
  const backorders = [];

  for (const l of order.lines) {
    if (l.status === 'ok') {
      rows.push(`  - ${l.description} x ${l.quantity} ${l.unit} @ PHP ${money(l.unitPrice)} = PHP ${money(l.extendedPrice)}`);
    } else if (l.status === 'insufficient_stock') {
      rows.push(`  - ${l.description} x ${l.quantity} ${l.unit} @ PHP ${money(l.unitPrice)} = PHP ${money(l.extendedPrice)}  [PARTIAL/BACKORDER - see note]`);
    } else if (l.status === 'partial') {
      rows.push(`  - ${l.description} x ${l.shipQty} ${l.unit} (shipping now) @ PHP ${money(l.unitPrice)} = PHP ${money(l.extendedPrice)}`);
      backorders.push(`  - ${l.description}: ${l.backorderQty} ${l.unit} on backorder, will ship once restocked`);
    } else if (l.status === 'backordered') {
      backorders.push(`  - ${l.description}: ${l.backorderQty} ${l.unit} on backorder, will ship once restocked`);
    }
  }

  let body = `Subject: Invoice ${inv.invoiceNumber} for PO ${inv.poNumber}\n\n`;
  body += `Hi ${inv.customer.name},\n\n`;
  body += `Thank you for your order. Here is a summary of what we can confirm so far:\n\n`;
  body += (rows.length ? rows.join('\n') : '  (no items confirmed yet)') + '\n\n';
  if (backorders.length) {
    body += `Backordered:\n${backorders.join('\n')}\n\n`;
  }
  body += `Subtotal: PHP ${money(inv.subtotal)}\n`;
  body += `VAT (${(inv.vatRate * 100).toFixed(0)}%): PHP ${money(inv.vat)}\n`;
  body += `Total: PHP ${money(inv.total)}\n`;
  body += `Terms: ${inv.customer.terms}\n\n`;
  if (order.exceptions.length > 0) {
    body += `A couple of items on your order need a quick check from our team before we can finalize everything — someone will follow up shortly.\n\n`;
  }
  body += `Best regards,\n[Your Company Name]`;
  return body;
}

function save() {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(store, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function addHistory(order, by, text, at) {
  order.history.push({ at: at || nowIso(), by, text });
}

function createOrder(rawText, extracted, opts = {}) {
  const at = opts.at || nowIso();
  const seq = store.nextSeq++;
  const order = {
    id: `ORD-${seq}`,
    invoiceNumber: `INV-${seq}`,
    createdAt: at,
    sample: !!opts.sample,
    status: 'needs_review',
    rawText,
    poNumber: extracted.poNumber || '',
    customerNameGuess: extracted.customerNameGuess || '',
    customerEmailGuess: extracted.customerEmailGuess || '',
    deliveryNotes: extracted.deliveryNotes || '',
    customer: matchCustomer(extracted.customerNameGuess, extracted.customerEmailGuess),
    lines: extracted.lineItems.map(li => ({
      rawText: li.rawText,
      description: li.description,
      quantity: li.quantity,
      unit: li.unit,
      matchedSku: li.matchedSku || null,
      matchConfidence: li.matchConfidence
    })),
    history: []
  };
  evaluate(order);
  order.initialExceptionCount = order.exceptions.length;
  order.autoProcessedCount = order.lines.filter(l => l.status === 'ok').length;
  order.totalLineCount = order.lines.length;
  addHistory(order, 'AI', 'Read the PO, matched items to the catalog, checked stock and drafted the invoice and reply.', at);
  store.orders.push(order);
  save();
  return order;
}

function getOrder(id) {
  const order = store.orders.find(o => o.id === id);
  if (!order) throw new OrderError('Order not found.', 404);
  return order;
}

function assertEditable(order) {
  if (order.status === 'sent') throw new OrderError('This order has already been sent and can no longer be edited.', 409);
}

function updateLine(id, index, patch, at) {
  const order = getOrder(id);
  assertEditable(order);
  const line = order.lines[index];
  if (!line) throw new OrderError('Line not found.', 404);

  if (patch.sku !== undefined) {
    const rec = inventory.find(r => r.sku === patch.sku);
    if (!rec) throw new OrderError('That SKU is not in the catalog.');
    line.matchedSku = rec.sku;
    line.matchConfidence = 'manual';
    delete line.stockResolution;
    addHistory(order, 'Staff', `Matched "${line.rawText}" to ${rec.sku} (${rec.description}).`, at);
  }
  if (patch.quantity !== undefined) {
    const qty = Number(patch.quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new OrderError('Quantity must be a number greater than zero.');
    addHistory(order, 'Staff', `Changed quantity of "${line.description}" from ${line.quantity} to ${qty}.`, at);
    line.quantity = qty;
  }
  if (patch.stockResolution !== undefined) {
    if (!['ship_available', 'backorder_all'].includes(patch.stockResolution)) throw new OrderError('Unknown stock decision.');
    line.stockResolution = patch.stockResolution;
    addHistory(order, 'Staff', patch.stockResolution === 'ship_available'
      ? `Chose to ship what's on hand for "${line.description}" and backorder the rest.`
      : `Chose to backorder all of "${line.description}".`, at);
  }
  if (patch.removed !== undefined) {
    line.removed = !!patch.removed;
    addHistory(order, 'Staff', `${line.removed ? 'Removed' : 'Restored'} line "${line.description || line.rawText}".`, at);
  }

  evaluate(order);
  save();
  return order;
}

function setCustomer(id, body, at) {
  const order = getOrder(id);
  assertEditable(order);

  if (body.existing) {
    const found = allCustomers().find(c => c.name === body.existing);
    if (!found) throw new OrderError('Customer not found.');
    order.customer = found;
    addHistory(order, 'Staff', `Assigned the order to existing customer ${found.name}.`, at);
  } else if (body.new) {
    const name = String(body.new.name || '').trim();
    const email = String(body.new.email || '').trim();
    const terms = String(body.new.terms || '').trim() || 'Net 30';
    if (!name) throw new OrderError('Customer name is required.');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new OrderError('Enter a valid customer email.');
    const customer = { name, email, terms };
    store.extraCustomers.push(customer);
    order.customer = customer;
    addHistory(order, 'Staff', `Added ${name} as a new customer (${terms}) and assigned the order.`, at);
  } else {
    throw new OrderError('Choose an existing customer or add a new one.');
  }

  evaluate(order);
  save();
  return order;
}

function sendOrder(id, emailText, at) {
  const order = getOrder(id);
  if (order.status === 'sent') throw new OrderError('This order was already sent.', 409);
  if (order.exceptions.length > 0) throw new OrderError('Resolve every flagged item before sending.', 409);
  order.status = 'sent';
  order.sentAt = at || nowIso();
  order.sentEmail = (emailText && emailText.trim()) ? emailText : order.draftEmail;
  addHistory(order, 'Staff', `Approved and sent the reply to ${order.invoice.customer.email} (demo — no real email is sent).`, at);
  save();
  return order;
}

function summarize(o) {
  return {
    id: o.id,
    createdAt: o.createdAt,
    status: o.status,
    sample: o.sample,
    poNumber: o.invoice.poNumber,
    customerName: o.invoice.customer.name,
    total: o.invoice.total,
    lineCount: o.lines.filter(l => !l.removed).length,
    exceptionCount: o.exceptions.length,
    initialExceptionCount: o.initialExceptionCount
  };
}

function listOrders() {
  return store.orders.map(summarize).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function computeStats() {
  const orders = store.orders;
  const untouched = orders.filter(o => o.initialExceptionCount === 0).length;
  const minutesSaved = orders.reduce(
    (sum, o) => sum + MANUAL_MINUTES_PER_PO - (o.initialExceptionCount === 0 ? STAFF_MINUTES_UNTOUCHED : STAFF_MINUTES_WITH_EXCEPTIONS),
    0
  );
  return {
    total: orders.length,
    needsReview: orders.filter(o => o.status === 'needs_review').length,
    ready: orders.filter(o => o.status === 'ready').length,
    sent: orders.filter(o => o.status === 'sent').length,
    untouched,
    hoursSaved: Math.round((minutesSaved / 60) * 10) / 10,
    assumptions: {
      manualMinutesPerPO: MANUAL_MINUTES_PER_PO,
      staffMinutesUntouched: STAFF_MINUTES_UNTOUCHED,
      staffMinutesWithExceptions: STAFF_MINUTES_WITH_EXCEPTIONS
    }
  };
}

function item(rawText, description, quantity, unit, matchedSku, matchConfidence) {
  return { rawText, description, quantity, unit, matchedSku, matchConfidence };
}

function seedOrders() {
  store = { nextSeq: 1001, orders: [], extraCustomers: [] };
  const now = Date.now();
  const ago = ms => new Date(now - ms).toISOString();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  const a = createOrder(
    'From: purchasing@meridianhardware.example\nSubject: Purchase Order #PO-10231\n\nHi,\n\nPlease process the following order for Meridian Hardware & Supply.\n\nPO Number: PO-10231\nItems:\n1. Steel Pipe 2" x 6m - 50 pcs\n2. Portland Cement 40kg - 100 bags\n3. THHN Wire #14 (100m roll) - 10 rolls\n\nThanks,\nRicardo Cruz',
    {
      poNumber: 'PO-10231', customerNameGuess: 'Meridian Hardware & Supply', customerEmailGuess: 'purchasing@meridianhardware.example', deliveryNotes: '',
      lineItems: [
        item('Steel Pipe 2" x 6m - 50 pcs', 'Steel Pipe 2" x 6m', 50, 'pcs', 'STL-PIPE-2IN', 'high'),
        item('Portland Cement 40kg - 100 bags', 'Portland Cement 40kg Bag', 100, 'bags', 'CEM-40KG', 'high'),
        item('THHN Wire #14 (100m roll) - 10 rolls', 'THHN Wire #14 (100m roll)', 10, 'rolls', 'WIRE-THHN-14', 'high')
      ]
    },
    { sample: true, at: ago(26 * HOUR) }
  );
  sendOrder(a.id, null, ago(25 * HOUR));

  const b = createOrder(
    'From: purchasing@meridianhardware.example\nSubject: PO-10198\n\nHello,\n\nKindly supply:\n- GI Sheet 26 Gauge 4x8ft - 30 sheets\n- Common Wire Nails 1kg - 12 kg\n\nPO: PO-10198\nThanks,\nRicardo Cruz',
    {
      poNumber: 'PO-10198', customerNameGuess: 'Meridian Hardware & Supply', customerEmailGuess: 'purchasing@meridianhardware.example', deliveryNotes: '',
      lineItems: [
        item('GI Sheet 26 Gauge 4x8ft - 30 sheets', 'GI Sheet 26 Gauge 4x8ft', 30, 'sheets', 'GI-SHEET-26G', 'high'),
        item('Common Wire Nails 1kg - 12 kg', 'Common Wire Nails 1kg', 12, 'kg', 'NAIL-CW-1KG', 'high')
      ]
    },
    { sample: true, at: ago(20 * HOUR) }
  );
  updateLine(b.id, 1, { stockResolution: 'ship_available' }, ago(19.5 * HOUR));
  sendOrder(b.id, null, ago(19 * HOUR));

  createOrder(
    'From: orders@coastalbuilders.example\nSubject: PO-88377\n\nHi team,\n\nPlease prepare:\nDeformed Rebar 10mm x 6m - 150 pcs\nPortland Cement 40kg - 200 bags\n\nThanks,\nJenny Alvarez',
    {
      poNumber: 'PO-88377', customerNameGuess: 'Coastal Builders Co.', customerEmailGuess: 'orders@coastalbuilders.example', deliveryNotes: '',
      lineItems: [
        item('Deformed Rebar 10mm x 6m - 150 pcs', 'Deformed Rebar 10mm x 6m', 150, 'pcs', 'REBAR-10MM', 'high'),
        item('Portland Cement 40kg - 200 bags', 'Portland Cement 40kg Bag', 200, 'bags', 'CEM-40KG', 'high')
      ]
    },
    { sample: true, at: ago(5 * HOUR) }
  );

  createOrder(
    'From: orders@coastalbuilders.example\nSubject: PO-88410 - Urgent\n\nGood day,\n\nWe\'d like to place an order for the following, PO-88410:\n\n- Marine Plywood 1/2" 4x8ft x 40 sheets\n- Common Wire Nails 1kg x 20 kg\n- GI Sheet 26 Gauge 4x8ft x 25 sheets\n\nNeeded by end of week for the Coastal Builders Co. site.\n\nRegards,\nJenny Alvarez',
    {
      poNumber: 'PO-88410', customerNameGuess: 'Coastal Builders Co.', customerEmailGuess: 'orders@coastalbuilders.example', deliveryNotes: 'Needed by end of week',
      lineItems: [
        item('Marine Plywood 1/2" 4x8ft x 40 sheets', 'Marine Plywood 1/2" 4x8ft', 40, 'sheets', 'PLY-1/2-4X8', 'high'),
        item('Common Wire Nails 1kg x 20 kg', 'Common Wire Nails 1kg', 20, 'kg', 'NAIL-CW-1KG', 'high'),
        item('GI Sheet 26 Gauge 4x8ft x 25 sheets', 'GI Sheet 26 Gauge 4x8ft', 25, 'sheets', 'GI-SHEET-26G', 'high')
      ]
    },
    { sample: true, at: ago(3 * HOUR) }
  );

  createOrder(
    'Summit Construction Group here, procurement@summitconstruction.example\n\nplease supply below for our ongoing project (ref: SUM-2231):\n\nrebar 10mm - 200pcs\npvc pipe 4in x3m - 60 pieces\nsolar panel 400w - 5 units\nlatex paint 4l white - 8 pails\n\nsend so we can process payment on our end (30 days terms)',
    {
      poNumber: 'SUM-2231', customerNameGuess: 'Summit Construction Group', customerEmailGuess: 'procurement@summitconstruction.example', deliveryNotes: '',
      lineItems: [
        item('rebar 10mm - 200pcs', 'Deformed Rebar 10mm x 6m', 200, 'pcs', 'REBAR-10MM', 'high'),
        item('pvc pipe 4in x3m - 60 pieces', 'PVC Pipe 4" x 3m', 60, 'pieces', 'PVC-4IN-3M', 'high'),
        item('solar panel 400w - 5 units', 'Solar Panel 400W', 5, 'units', null, 'none'),
        item('latex paint 4l white - 8 pails', 'Latex Paint 4L (White)', 8, 'pails', 'PAINT-LAT-4L', 'high')
      ]
    },
    { sample: true, at: ago(90 * MIN) }
  );

  createOrder(
    'From: orders@pacificridge.example\nSubject: Order request\n\nGood afternoon,\n\nPacific Ridge Trading would like to order:\nPVC Pipe 4in x 3m - 30 pcs\nLatex paint 4L white - 4 pails\n\nPlease send an invoice. We are a new customer.\n\nRegards,\nMarco Dela Rosa',
    {
      poNumber: '', customerNameGuess: 'Pacific Ridge Trading', customerEmailGuess: 'orders@pacificridge.example', deliveryNotes: '',
      lineItems: [
        item('PVC Pipe 4in x 3m - 30 pcs', 'PVC Pipe 4" x 3m', 30, 'pcs', 'PVC-4IN-3M', 'high'),
        item('Latex paint 4L white - 4 pails', 'Latex Paint 4L (White)', 4, 'pails', 'PAINT-LAT-4L', 'high')
      ]
    },
    { sample: true, at: ago(25 * MIN) }
  );

  save();
}

function load() {
  if (fs.existsSync(ORDERS_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
      return;
    } catch (err) {
      console.warn('Could not read data/orders.json, reseeding sample orders.');
    }
  }
  seedOrders();
}

load();

module.exports = {
  inventory,
  allCustomers,
  createOrder,
  getOrder,
  updateLine,
  setCustomer,
  sendOrder,
  listOrders,
  computeStats,
  seedOrders,
  OrderError
};
