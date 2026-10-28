require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const E = process.env;
const PORT = E.PORT || 3000;
const BASE = E.BASE_URL || `http://localhost:${PORT}`;
const CUR = E.CURRENCY || 'GHS';
const RATE = +E.CNY_RATE || 2.0;
const MARKUP = +E.MARKUP || 0.35;
const SHIP_KG = +E.SHIP_PER_KG || 90;
const FEE = +E.DELIVERY_FEE || 30;
const supplier = require('./suppliers/' + (E.SUPPLIER || 'mock'));

const db = new Database('shop.db');
db.exec(`
create table if not exists products(
  id integer primary key, src_id text unique, title text, image text, cny real, kg real, price real);
create table if not exists orders(
  ref text primary key, name text, phone text, email text, address text, city text,
  items text, subtotal real, fee real, total real, status text default 'pending',
  created text default current_timestamp);
`);

// landed price = (item cost + freight) + markup, in local currency
const priceOf = (cny, kg) => Math.ceil((cny * RATE + kg * SHIP_KG) * (1 + MARKUP));
const STATUSES = ['pending', 'paid', 'purchased', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];

const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.raw = buf) }));
app.use(express.static('public'));

const admin = (req, res, next) =>
  E.ADMIN_TOKEN && req.get('x-admin-token') === E.ADMIN_TOKEN ? next() : res.sendStatus(401);

const markPaid = ref =>
  db.prepare("update orders set status='paid' where ref=? and status='pending'").run(ref);

async function paystack(path, opts = {}) {
  const r = await fetch('https://api.paystack.co' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET, 'Content-Type': 'application/json' },
  });
  return r.json();
}

// ---- catalog ----
app.get('/api/products', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const items = db.prepare('select id,title,image,price from products where title like ? order by id desc limit 60').all(q);
  res.json({ currency: CUR, items });
});

app.post('/api/admin/import', admin, async (req, res) => {
  try {
    const list = await supplier.search(req.body.q || '');
    const up = db.prepare(`insert into products(src_id,title,image,cny,kg,price) values(?,?,?,?,?,?)
      on conflict(src_id) do update set title=excluded.title,image=excluded.image,cny=excluded.cny,kg=excluded.kg,price=excluded.price`);
    db.transaction(() => list.forEach(p => up.run(p.id, p.title, p.image, p.cny, p.kg, priceOf(p.cny, p.kg))))();
    res.json({ imported: list.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- checkout (prices are always recomputed on the server) ----
app.post('/api/checkout', async (req, res) => {
  try {
    const { items = [], name, phone, email, address, city } = req.body;
    if (!items.length || !name || !phone || !email || !address)
      return res.status(400).json({ error: 'Fill in name, phone, email and delivery address.' });

    let subtotal = 0;
    const lines = [];
    for (const i of items) {
      const p = db.prepare('select id,title,price from products where id=?').get(i.id);
      if (!p) return res.status(400).json({ error: 'An item in your cart is no longer available.' });
      const qty = Math.max(1, Math.min(99, parseInt(i.qty, 10) || 1));
      subtotal += p.price * qty;
      lines.push({ id: p.id, title: p.title, price: p.price, qty });
    }
    const total = subtotal + FEE;
    const ref = 'ORD' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    db.prepare('insert into orders(ref,name,phone,email,address,city,items,subtotal,fee,total) values(?,?,?,?,?,?,?,?,?,?)')
      .run(ref, name, phone, email, address, city || '', JSON.stringify(lines), subtotal, FEE, total);

    if (!E.PAYSTACK_SECRET) return res.json({ url: `/api/dev-pay?ref=${ref}` });

    const j = await paystack('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email, amount: Math.round(total * 100), currency: CUR, reference: ref,
        channels: ['card', 'mobile_money'],
        callback_url: `${BASE}/?ref=${ref}`,
        metadata: { name, phone },
      }),
    });
    j.status ? res.json({ url: j.data.authorization_url }) : res.status(502).json({ error: j.message });
  } catch (e) {
    res.status(500).json({ error: 'Could not start payment. Try again.' });
  }
});

// dev-only: pretend payment succeeded
app.get('/api/dev-pay', (req, res) => {
  if (E.PAYSTACK_SECRET) return res.sendStatus(404);
  markPaid(req.query.ref);
  res.redirect(`/?ref=${encodeURIComponent(req.query.ref)}`);
});

// Paystack webhook (set this URL in the Paystack dashboard)
app.post('/api/webhook/paystack', (req, res) => {
  const sig = crypto.createHmac('sha512', E.PAYSTACK_SECRET || '').update(req.raw || '').digest('hex');
  if (!E.PAYSTACK_SECRET || sig !== req.get('x-paystack-signature')) return res.sendStatus(401);
  const ev = req.body;
  if (ev.event === 'charge.success') {
    const o = db.prepare('select total from orders where ref=?').get(ev.data.reference);
    if (o && ev.data.amount === Math.round(o.total * 100)) markPaid(ev.data.reference);
  }
  res.sendStatus(200);
});

// ---- order tracking ----
app.get('/api/orders/:ref', async (req, res) => {
  let o = db.prepare('select * from orders where ref=?').get(req.params.ref);
  if (!o) return res.sendStatus(404);
  if (o.status === 'pending' && E.PAYSTACK_SECRET) {
    try {
      const j = await paystack('/transaction/verify/' + encodeURIComponent(o.ref));
      if (j.status && j.data.status === 'success' && j.data.amount === Math.round(o.total * 100)) {
        markPaid(o.ref);
        o = db.prepare('select * from orders where ref=?').get(o.ref);
      }
    } catch (_) {}
  }
  res.json({ ref: o.ref, status: o.status, total: o.total, currency: CUR, items: JSON.parse(o.items), created: o.created });
});

// ---- admin ----
app.get('/api/admin/orders', admin, (_req, res) => {
  const rows = db.prepare('select * from orders order by created desc limit 200').all();
  res.json({ statuses: STATUSES, currency: CUR, orders: rows.map(o => ({ ...o, items: JSON.parse(o.items) })) });
});

app.post('/api/admin/orders/:ref/status', admin, (req, res) => {
  if (!STATUSES.includes(req.body.status)) return res.sendStatus(400);
  db.prepare('update orders set status=? where ref=?').run(req.body.status, req.params.ref);
  res.sendStatus(204);
});

app.listen(PORT, () => console.log(`Shop running on ${BASE}  (admin: ${BASE}/admin.html)`));
