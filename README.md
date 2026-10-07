# iKM PDF to Excel

The converter uses the project skill's PDF annotation extractor and workbook builder. It reads Thai text from browser-saved PDFs, keeps only rows with clickable URLs, and writes the nine columns from the sample workbook.

## Run locally

```powershell
python -m pip install -r requirements.txt
python server.py
```

The terminal shows the server address after startup (and uses a nearby port if port 8000 is busy). Open that address and drop one or more browser-saved PDFs. Review the extracted rows and edit Detail text directly in the preview before exporting. The server listens only on the local computer. Use Ctrl+C in the terminal to stop it.

Export names are sanitized and limited to 31 characters, including the `.xlsx` extension.

PDFs must preserve their clickable links. In Chrome or Edge, use Print → Save as PDF. A screenshot or a PDF printed as an image does not contain link destinations, so those URLs cannot be reconstructed from the page text.
