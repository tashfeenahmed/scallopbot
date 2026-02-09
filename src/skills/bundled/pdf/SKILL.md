---
name: pdf
description: "Create beautiful PDFs with professional typography, read/extract text from PDFs, and edit/manipulate existing PDFs."
user-invocable: false
triggers: [pdf, document, report, letter, invoice, resume, typst, typeset, print]
metadata:
  openclaw:
    emoji: "\U0001F4C4"
    requires:
      bins: [typst]
    install:
      - id: brew-typst
        kind: brew
        package: typst
        bins: [typst]
        label: "Install Typst CLI"
---

# PDF Skill

Create, read, and edit PDFs using CLI tools.

## Core Workflow — Creating PDFs

Every PDF creation follows this pattern:

1. **Write** a `.typ` file using `write_file`
2. **Compile** with `typst compile input.typ output.pdf`
3. **Send** with `send_file`

### Minimal Example

```typst
#set page(paper: "us-letter", margin: 1in)
#set text(font: "New Computer Modern", size: 11pt)

= My Report

This is a paragraph with *bold* and _italic_ text.

- First item
- Second item

#table(
  columns: (1fr, 1fr, 1fr),
  [*Name*], [*Role*], [*Status*],
  [Alice], [Engineer], [Active],
  [Bob], [Designer], [Active],
)
```

Save as `report.typ`, then:

```bash
typst compile report.typ report.pdf
```

## Essential Typst Syntax

### Text Formatting

```typst
*bold*          _italic_          `monospace`
#underline[underlined]            #strike[struck]
#smallcaps[Small Caps]            #super[sup]  #sub[sub]
#text(fill: blue)[colored text]   #text(size: 14pt)[larger]
```

### Headings

```typst
= Level 1
== Level 2
=== Level 3
```

To number headings:

```typst
#set heading(numbering: "1.1")
```

### Lists

```typst
- Bullet item
  - Nested item
- Another item

+ Numbered item
+ Another numbered item

/ Term: Definition
/ Another: Its definition
```

### Tables

```typst
#table(
  columns: (auto, 1fr, 1fr),
  align: (left, center, right),
  table.header([*Col A*], [*Col B*], [*Col C*]),
  [Row 1A], [Row 1B], [Row 1C],
  [Row 2A], [Row 2B], [Row 2C],
)
```

### Images

```typst
#image("photo.jpg", width: 50%)

#figure(
  image("chart.png", width: 80%),
  caption: [Monthly revenue growth],
)
```

### Links

```typst
#link("https://example.com")[Click here]
```

### Page Breaks

```typst
#pagebreak()
```

### Math

Inline: $x^2 + y^2 = z^2$

Display:

```typst
$ sum_(i=1)^n i = (n(n+1)) / 2 $
```

### Horizontal Rule

```typst
#line(length: 100%, stroke: 0.5pt + gray)
```

## Font Selection

**Serif** (reports, letters, academic):
```typst
#set text(font: "New Computer Modern", size: 11pt)
```

**Sans-serif** (modern, presentations):
```typst
#set text(font: "Helvetica Neue", size: 11pt)
```

List available fonts:
```bash
typst fonts
```

## Page Layout

### Margins and Paper Size

```typst
#set page(
  paper: "us-letter",  // or "a4"
  margin: (top: 1in, bottom: 1in, left: 1in, right: 1in),
)
```

### Headers and Footers

```typst
#set page(
  header: context {
    if counter(page).get().first() > 1 [
      _My Document_ #h(1fr) #datetime.today().display("[month repr:long] [day], [year]")
      #line(length: 100%, stroke: 0.5pt + gray)
    ]
  },
  footer: context {
    let pg = counter(page).get().first()
    if pg > 1 [
      #h(1fr) #pg #h(1fr)
    ]
  },
)
```

### Multi-Column

```typst
#columns(2, gutter: 12pt)[
  Left column content...
  #colbreak()
  Right column content...
]
```

## Color and Styling

### Accent Colors

```typst
#let accent = rgb("#2563EB")  // Professional blue

#show heading.where(level: 1): set text(fill: accent)
#show heading.where(level: 2): set text(fill: accent.darken(20%))
```

### Callout Box

```typst
#block(
  fill: rgb("#EFF6FF"),
  stroke: rgb("#2563EB") + 1pt,
  inset: 12pt,
  radius: 4pt,
  width: 100%,
)[
  *Note:* This is a highlighted callout box.
]
```

## Quick Document Patterns

### Report

```typst
#set page(paper: "us-letter", margin: 1in)
#set text(font: "New Computer Modern", size: 11pt)
#set heading(numbering: "1.1")
#let accent = rgb("#2563EB")
#show heading.where(level: 1): set text(fill: accent)

#align(center)[
  #text(size: 24pt, weight: "bold")[Report Title]
  #v(8pt)
  #text(size: 12pt, fill: gray)[Author Name — #datetime.today().display("[month repr:long] [day], [year]")]
]
#v(1em)

#outline(title: "Contents", indent: auto)
#pagebreak()

= Introduction
Your introduction here...
```

### Letter

```typst
#set page(paper: "us-letter", margin: 1in)
#set text(font: "New Computer Modern", size: 11pt)

#align(right)[
  Your Name \
  123 Street \
  City, State 12345
]
#v(1em)
#datetime.today().display("[month repr:long] [day], [year]")
#v(1em)
Recipient Name \
Company \
Address
#v(1em)

Dear Recipient,

Your letter body here...

Sincerely, \
Your Name
```

### Table-Heavy Document

```typst
#set page(paper: "us-letter", margin: 0.75in)
#set text(font: "Helvetica Neue", size: 10pt)
#let accent = rgb("#2563EB")

#table(
  columns: (2fr, 1fr, 1fr, 1fr),
  fill: (_, row) => if row == 0 { accent } else if calc.odd(row) { luma(245) },
  table.header(
    ..([*Item*], [*Qty*], [*Price*], [*Total*]).map(c => text(fill: white, c))
  ),
  [Widget A], [10], [$5.00], [$50.00],
  [Widget B], [25], [$3.50], [$87.50],
  [Widget C], [5], [$12.00], [$60.00],
)
```

## Reading PDFs

Requires `poppler-utils` (`brew install poppler` / `apt install poppler-utils`).

### Extract Text

```bash
pdftotext input.pdf -              # to stdout
pdftotext input.pdf output.txt     # to file
pdftotext -layout input.pdf -      # preserve layout
pdftotext -f 2 -l 5 input.pdf -   # pages 2-5
```

### Get PDF Info

```bash
pdfinfo input.pdf                  # metadata, page count, size
```

If `pdftotext` is not installed, tell the user and offer to install it.

**Note:** Scanned PDFs (image-only) will produce empty output from `pdftotext`. OCR requires additional tools.

## Editing PDFs

Requires `qpdf` (`brew install qpdf` / `apt install qpdf`).

### Merge

```bash
qpdf --empty --pages file1.pdf file2.pdf file3.pdf -- merged.pdf
```

### Split / Extract Pages

```bash
qpdf input.pdf --pages . 1-5 -- first-five.pdf
qpdf input.pdf --pages . 3,7,12 -- selected.pdf
```

### Rotate

```bash
qpdf input.pdf --rotate=+90:1-5 -- rotated.pdf    # rotate pages 1-5
```

### Encrypt

```bash
qpdf --encrypt userpass ownerpass 256 -- input.pdf encrypted.pdf
```

### Decrypt

```bash
qpdf --password=ownerpass --decrypt input.pdf decrypted.pdf
```

If `qpdf` is not installed, tell the user and offer to install it.

## Deep-Dive Documentation

For advanced usage, read the reference docs:

| Topic | File |
|-------|------|
| Advanced Typst syntax | `references/typst-syntax.md` |
| PDF reading (pdftotext/pdfinfo) | `references/pdf-reading.md` |
| PDF editing (qpdf) | `references/pdf-editing.md` |

## Ready-to-Use Templates

Copy and customize these compilable templates:

| Template | File | Description |
|----------|------|-------------|
| Report | `templates/report.typ` | Title page, TOC, headers/footers, tables |
| Letter | `templates/letter.typ` | Sender/recipient, date, body, closing |
| Invoice | `templates/invoice.typ` | Line items, subtotal/tax/total, color accents |
