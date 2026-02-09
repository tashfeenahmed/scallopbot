# PDF Reading Reference

Extract text and metadata from PDFs using `poppler-utils`.

## Installation

```bash
# macOS
brew install poppler

# Ubuntu / Debian
apt install -y poppler-utils

# Verify
pdftotext -v
```

## pdftotext — Extract Text

### Basic Usage

```bash
pdftotext input.pdf -              # print to stdout
pdftotext input.pdf output.txt     # write to file
```

### Preserve Layout

```bash
pdftotext -layout input.pdf -      # keep original positioning
```

### Page Range

```bash
pdftotext -f 3 -l 7 input.pdf -   # extract pages 3 through 7
pdftotext -f 1 -l 1 input.pdf -   # first page only
```

### Encoding

```bash
pdftotext -enc UTF-8 input.pdf -   # explicit UTF-8 (default)
pdftotext -enc Latin1 input.pdf -  # Latin-1 encoding
```

### Raw Mode

```bash
pdftotext -raw input.pdf -         # keep strings in content stream order
```

## pdfinfo — PDF Metadata

### Basic Info

```bash
pdfinfo input.pdf
```

Output includes:
- Title, Author, Subject, Keywords
- Creator, Producer
- Page count, Page size
- File size, PDF version
- Encrypted (yes/no)

### Page Count Only

```bash
pdfinfo input.pdf | grep "Pages:" | awk '{print $2}'
```

## Common Patterns

### Extract and Summarize

```bash
# Get text from PDF for analysis
text=$(pdftotext document.pdf -)
echo "$text"
```

### Check Page Count Before Processing

```bash
pages=$(pdfinfo document.pdf | grep "Pages:" | awk '{print $2}')
echo "Document has $pages pages"
```

### Extract Specific Pages for Review

```bash
pdftotext -f 1 -l 3 report.pdf - > first_three_pages.txt
```

## Limitations

- **Scanned PDFs**: `pdftotext` extracts embedded text only. Image-only (scanned) PDFs will produce empty output. OCR requires additional tools like `tesseract`.
- **Complex layouts**: Multi-column or heavily formatted PDFs may not extract cleanly. Use `-layout` for better results.
- **Tables**: Table structure is not preserved; columns may merge. Consider extracting to layout mode and post-processing.
