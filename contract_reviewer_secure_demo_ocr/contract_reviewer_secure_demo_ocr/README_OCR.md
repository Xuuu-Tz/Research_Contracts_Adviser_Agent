# Contract Reviewer Secure Demo with OCR

This version supports:
- TXT
- DOCX via Mammoth.js
- text-based PDF via PDF.js
- scanned/image PDF via Tesseract.js OCR fallback

## Run
1. open .evn
2. Fill in your Azure OpenAI endpoint, deployment, API version, and key.
3. Run:

```bash
npm.cmd install
npm.cmd start
```

4. Open `index.html` in your browser.

## Notes
- For text-based PDFs, OCR is not used.
- For scanned PDFs, OCR runs in the browser and may be slow. Use 1-3 page PDFs for demo.
- Do not commit or share `.env`.
