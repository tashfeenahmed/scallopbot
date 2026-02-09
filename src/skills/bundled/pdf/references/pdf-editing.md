# PDF Editing Reference

Manipulate existing PDFs using `qpdf`.

## Installation

```bash
# macOS
brew install qpdf

# Ubuntu / Debian
apt install -y qpdf

# Verify
qpdf --version
```

## Merge PDFs

Combine multiple PDFs into one:

```bash
qpdf --empty --pages file1.pdf file2.pdf file3.pdf -- merged.pdf
```

Merge specific pages from each file:

```bash
qpdf --empty --pages file1.pdf 1-5 file2.pdf 3,7-10 -- merged.pdf
```

## Split / Extract Pages

### Extract a Page Range

```bash
qpdf input.pdf --pages . 1-5 -- first-five.pdf
```

### Extract Specific Pages

```bash
qpdf input.pdf --pages . 1,3,5,7 -- selected.pdf
```

### Split into Individual Pages

```bash
qpdf input.pdf --split-pages output-%d.pdf
```

### Extract All Except Certain Pages

```bash
# Extract all except pages 3-5 from a 10-page doc
qpdf input.pdf --pages . 1-2,6-10 -- without-3-5.pdf
```

## Rotate Pages

```bash
qpdf input.pdf --rotate=+90:1-5 -- rotated.pdf     # rotate pages 1-5 by 90°
qpdf input.pdf --rotate=+180 -- flipped.pdf         # rotate all pages 180°
qpdf input.pdf --rotate=+90:1 -- rotated.pdf        # rotate just page 1
```

Rotation values: `+90`, `+180`, `+270`, `-90`

## Encrypt / Password Protect

### Set Passwords

```bash
qpdf --encrypt userpass ownerpass 256 -- input.pdf encrypted.pdf
```

- `userpass`: password to open/view the document
- `ownerpass`: password for full permissions (editing, printing)
- `256`: encryption key length (use 256 for AES-256)

### Restrict Permissions

```bash
qpdf --encrypt user owner 256 \
  --print=none \
  --modify=none \
  --extract=n \
  -- input.pdf restricted.pdf
```

### Use Empty User Password (No Password to View)

```bash
qpdf --encrypt "" ownerpass 256 -- input.pdf encrypted.pdf
```

## Decrypt

```bash
qpdf --password=ownerpass --decrypt input.pdf decrypted.pdf
```

## Overlay / Underlay (Watermark)

### Add Watermark (Behind Content)

```bash
qpdf input.pdf --underlay watermark.pdf -- output.pdf
```

### Add Stamp (On Top of Content)

```bash
qpdf input.pdf --overlay stamp.pdf -- output.pdf
```

### Apply to Specific Pages

```bash
qpdf input.pdf --overlay logo.pdf --to=1 -- output.pdf   # overlay on page 1 only
```

## Linearize (Web Optimize)

Optimize for fast web viewing (byte-serving):

```bash
qpdf --linearize input.pdf optimized.pdf
```

## Repair / Check

### Check PDF for Errors

```bash
qpdf --check input.pdf
```

### Repair Damaged PDF

```bash
qpdf input.pdf repaired.pdf       # qpdf fixes issues during rewrite
```

## Common Patterns

### Merge Then Encrypt

```bash
qpdf --empty --pages part1.pdf part2.pdf -- merged.pdf
qpdf --encrypt "" mypassword 256 -- merged.pdf final.pdf
```

### Extract, Rotate, Merge

```bash
qpdf doc.pdf --pages . 1-3 -- front.pdf
qpdf doc.pdf --pages . 4 -- p4.pdf
qpdf p4.pdf --rotate=+90 -- p4-rotated.pdf
qpdf --empty --pages front.pdf p4-rotated.pdf -- result.pdf
```
