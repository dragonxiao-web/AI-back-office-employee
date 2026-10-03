# AI Back-Office Employee — Purchase Order Desk

A working demo of an "AI employee" that handles a distributor's most repetitive back-office workflow: reading incoming purchase orders, checking stock, drafting the invoice, and drafting the reply to the customer. A human only steps in for the exceptions — an item that isn't in the catalog, a stock shortfall, or a customer the system doesn't recognize.

**The pitch this demo is built around:** instead of selling "AI automation," sell "a digital employee that costs a fraction of a hire and works 24/7." This prototype is the proof-of-concept for that pitch, aimed at distributors, wholesalers, hardware suppliers, and similar businesses that process a stream of purchase orders by hand today.

## The workflow it replaces

```
Email arrives → employee reads PO → re-types into spreadsheet → checks inventory
   → enters accounting system → creates invoice → emails the customer back
```

This app does everything except the last step (sending the email) automatically, and flags anything it isn't confident about for a human to review instead of guessing.

## How it works

```
Raw PO email/text
      │
      ▼
Claude (tool-use call) ── extracts PO #, customer, and line items,
      │                    matching each item to the closest SKU in
      │                    the product catalog (or "no match")
      ▼
Server-side business logic
      │  • looks up matched SKUs against mock inventory
      │  • flags: unrecognized item / insufficient stock / unknown customer
      │  • computes subtotal, VAT, total for the sellable lines
      ▼
Draft invoice + draft reply email
      │  rendered in the UI, exceptions called out separately
      ▼
Human reviews only the flagged exceptions
```

The AI is deliberately not allowed to force a bad match — if it isn't confident an item exists in the catalog, it says so instead of guessing, which is what makes the exception list trustworthy.

## Try it

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and add your own [Anthropic API key](https://console.anthropic.com/):
   ```bash
   cp .env.example .env
   ```
3. Run it:
   ```bash
   npm start
   ```
4. Open `http://localhost:3000`, click one of the three sample purchase orders, and hit **Process Purchase Order**.

No real accounts or integrations are required — inventory and customers are mock data in [`data/`](data), swappable for a real client's catalog to demo against their actual products.

## Sample run

Input (`data/sample-pos.json`, "Messy PO with an unknown item"):

```
Summit Construction Group here, procurement@summitconstruction.example

please supply below for our ongoing project (ref: SUM-2231):

rebar 10mm - 200pcs
pvc pipe 4in x3m - 60 pieces
solar panel 400w - 5 units
latex paint 4l white - 8 pails

send so we can process payment on our end (30 days terms)
```

Output:

| Item | Qty | SKU Match | Status |
|---|---|---|---|
| Deformed Rebar 10mm x 6m | 200 pcs | REBAR-10MM | OK |
| PVC Pipe 4" x 3m | 60 pieces | PVC-4IN-3M | OK |
| Solar Panel 400W | 5 units | *none* | **Needs review** |
| Latex Paint 4L (White) | 8 pails | PAINT-LAT-4L | OK |

> 3 of 4 line items auto-processed. 1 needs human review: *"solar panel 400w - 5 units" could not be confidently matched to a catalog item.*

The system still drafts an invoice (₱97,216.00 total) and a reply email for the 3 confirmed items, instead of blocking the whole order on the one it doesn't recognize.

Two more scenarios are built in: a clean PO with zero exceptions, and a PO that hits an inventory shortfall (partial-ship/backorder flagged automatically).

## Staff dashboard

Every processed PO is saved to a queue that staff work from at `/dashboard.html`:

- **Order queue** with status filters: Needs review, Ready to send, Sent
- **Exceptions inbox:** for each flagged item, staff pick the right catalog item, choose ship-what's-on-hand vs backorder, adjust a quantity, remove a line, or assign/add the customer
- **Live recalculation:** invoice totals and the draft reply update as each decision is made, and sending unlocks only when every flag is resolved
- **Activity log** per order (what the AI did, what staff changed) and a summary strip with an estimated time-saved figure
- Sending is simulated in this demo: the order is marked sent, but no real email leaves the app

Orders persist to `data/orders.json` (gitignored). The dashboard opens pre-filled with six example orders, tagged SAMPLE; **Reset demo data** at the bottom restores them.

## Tech stack

- Node.js + Express (backend, keeps the API key server-side)
- Anthropic API (`@anthropic-ai/sdk`), using tool-use to force structured JSON extraction instead of parsing free-text output
- Vanilla HTML/CSS/JS frontend — no build step

## Project structure

```
server.js              Express server, Claude extraction call, API routes
lib/orders.js           Order store + stock/invoice/exception logic
public/index.html       PO desk (process one order)
public/dashboard.html   Staff dashboard (queue, exceptions, approve & send)
data/inventory.json     Mock product catalog
data/customers.json     Mock customer directory
data/sample-pos.json    Three example purchase orders (clean / shortfall / unknown item)
```

## What's next for a real deployment

- Swap `data/inventory.json` / `data/customers.json` for a client's real catalog and customer list
- Connect to a real inbox (Gmail/Outlook API) instead of pasted text
- Write confirmed invoices to the client's actual accounting system (QuickBooks, Xero, etc.) instead of just drafting them
- Actually send the drafted reply email, pending a human's approval
