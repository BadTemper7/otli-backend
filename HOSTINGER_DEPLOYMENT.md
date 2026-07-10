# OTLI Hostinger Deployment Notes

## Server environment variables

Set these values in Hostinger Node.js App environment variables or in your server `.env` file:

```env
NODE_ENV=production
PORT=5000
CLIENT_ORIGINS=https://your-domain.com
CLIENT_PUBLIC_URL=https://your-domain.com

SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_REQUIRE_TLS=false
SMTP_USER=otli@onetrue.ph
SMTP_PASS=your_hostinger_mailbox_password
MAIL_FROM="OTLI Logistics <otli@onetrue.ph>"
MAIL_REPLY_TO=otli@onetrue.ph
```

Use the actual Hostinger mailbox password for `SMTP_PASS`. The SMTP username must be the complete mailbox address.

## Hostinger Node.js App

1. Upload the server project to the Node.js app folder.
2. Run `npm install --omit=dev`.
3. Set startup file to `src/server.js`.
4. Add all environment variables from `.env.example`.
5. Start or restart the Node.js app.
6. Test the API health endpoint: `/api/health`.

## Frontend

Build the frontend with the production API URL:

```env
VITE_API_URL=https://your-domain.com/api
VITE_SOCKET_URL=https://your-domain.com
```

Then run `npm run build` and upload the contents of `dist` to `public_html`. The included `.htaccess` handles React route refreshes.
