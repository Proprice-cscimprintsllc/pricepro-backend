require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('./supabaseClient');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: 'https://pricepro4u.netlify.app', credentials: true }));
app.use(cookieParser());

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const priceId = sub.items.data[0].price.id;
      let tier = 'free';
      if (priceId === process.env.STRIPE_SELLER_PRICE_ID) tier = 'seller';
      if (priceId === process.env.STRIPE_BUSINESS_PRICE_ID) tier = 'business';
      await supabase.from('subscribers').update({ tier, status: sub.status }).eq('stripe_subscription_id', sub.id);
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabase.from('subscribers').update({ tier: 'free', status: 'canceled' }).eq('stripe_subscription_id', sub.id);
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      await supabase.from('subscribers').update({ status: 'past_due' }).eq('stripe_customer_id', invoice.customer);
    }
  } catch (err) { console.error('Webhook handler error:', err); }
  res.json({ received: true });
});

app.use(express.json());

function signCookie(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64');
  const hmac = crypto.createHmac('sha256', process.env.COOKIE_SECRET);
  hmac.update(payload);
  return `${payload}.${hmac.digest('hex')}`;
}

function verifyCookie(cookie) {
  const dotIndex = cookie.indexOf('.');
  if (dotIndex === -1) return null;
  const payload = cookie.substring(0, dotIndex);
  const signature = cookie.substring(dotIndex + 1);
  const hmac = crypto.createHmac('sha256', process.env.COOKIE_SECRET);
  hmac.update(payload);
  if (hmac.digest('hex') !== signature) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); }
  catch { return null; }
}

app.post('/create-checkout-session', async (req, res) => {
  const { tier } = req.body;
  const priceId = tier === 'business' ? process.env.STRIPE_BUSINESS_PRICE_ID : process.env.STRIPE_SELLER_PRICE_ID;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://pricepro-backend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://pricepro4u.netlify.app/?canceled=true',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe session error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/success', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id, { expand: ['subscription'] });
    const email = session.customer_details.email;
    const priceId = session.subscription.items.data[0].price.id;
    const tier = priceId === process.env.STRIPE_BUSINESS_PRICE_ID ? 'business' : 'seller';
    await supabase.from('subscribers').upsert({
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription.id,
      email, tier, status: 'active',
    }, { onConflict: 'stripe_customer_id' });
    const cookieValue = signCookie({ tier, email, customerId: session.customer });
    res.cookie('pricepro_session', cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 2592000000,
    });
    res.redirect('https://pricepro4u.netlify.app/?unlocked=true');
  } catch (e) {
    console.error(e);
    res.redirect('https://pricepro4u.netlify.app/?error=true');
  }
});

app.get('/session', async (req, res) => {
  const cookie = req.cookies.pricepro_session;
  if (!cookie) return res.json({ tier: 'free' });
  const data = verifyCookie(cookie);
  if (!data) return res.json({ tier: 'free' });
  const { data: dbUser } = await supabase.from('subscribers').select('tier, status').eq('stripe_customer_id', data.customerId).single();
  if (dbUser && dbUser.status === 'active') return res.json({ tier: dbUser.tier });
  res.json({ tier: 'free' });
});

app.post('/logout', (req, res) => {
  res.clearCookie('pricepro_session', { secure: true, sameSite: 'none' });
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`PricePro backend running on port ${PORT}`));
