# Sabi Shop MVP

Sells Chinese products (1688 via a supplier adapter) with card + mobile money (Paystack) and home delivery.

## Run
    npm install
    cp .env.example .env     # set ADMIN_TOKEN, CNY_RATE, CURRENCY
    npm start
Open http://localhost:3000/admin.html, sign in, import products (mock supplier works with no keys), then shop at http://localhost:3000.

## Go live
1. Create a Paystack account, put the secret key in PAYSTACK_SECRET, and enable mobile money for your country.
2. Add `https://YOUR-DOMAIN/api/webhook/paystack` as the webhook URL in the Paystack dashboard.
3. Set SUPPLIER=onebound with OB_KEY / OB_SECRET (check field names in suppliers/onebound.js against their docs).
4. Set BASE_URL to your https domain and host on any Node server (Render, Railway, a VPS).

## Order flow
paid -> you buy on 1688 -> purchased -> shipped (freight) -> out_for_delivery -> delivered. Update status in admin.
