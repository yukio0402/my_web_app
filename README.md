# Company File Drop

Company File Drop is a small authorized transfer receiver for moving approved spreadsheet files from a browser to this Mac.

It is designed for cases where browser attachments are too slow or unreliable. The app receives files in chunks and saves them locally under `uploads/`.

## Use

```bash
npm start
```

Open:

```text
http://localhost:8787
```

Set a transfer code before exposing it outside the Mac:

```bash
TRANSFER_CODE='change-this-code' npm start
```

Then enter the same code in the browser UI.

## Cloudflare Tunnel

After installing `cloudflared`, expose the local app:

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the generated `https://...trycloudflare.com` URL from the company PC browser.

## Notes

- Files are stored on this Mac only.
- The app accepts spreadsheet-oriented extensions: `csv`, `tsv`, `xlsx`, `xls`, `xlsm`, `xlsb`, and `ods`.
- Uploads are chunked to work better with large files and Cloudflare request size limits.
- Keep the transfer code private and stop the server/tunnel when finished.
