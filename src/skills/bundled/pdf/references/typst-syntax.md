# Typst Syntax Reference

Comprehensive reference for Typst document authoring.

## Document Setup

### Page Configuration

```typst
#set page(
  paper: "us-letter",        // "a4", "us-letter", "us-legal"
  margin: (
    top: 1in,
    bottom: 1in,
    left: 1in,
    right: 1in,
  ),
  fill: white,                // background color
  columns: 1,                 // number of columns
)
```

### Text Defaults

```typst
#set text(
  font: "New Computer Modern", // font family
  size: 11pt,                  // base font size
  fill: black,                 // text color
  lang: "en",                  // language (for hyphenation)
)
```

### Paragraph

```typst
#set par(
  justify: true,              // justify text
  leading: 0.65em,            // line spacing
  first-line-indent: 0pt,     // paragraph indent
)
```

### Heading Configuration

```typst
#set heading(numbering: "1.1")    // numbered headings

// Custom heading styling
#show heading.where(level: 1): it => {
  set text(size: 18pt, fill: rgb("#2563EB"))
  v(12pt)
  it
  v(6pt)
}

#show heading.where(level: 2): it => {
  set text(size: 14pt, fill: rgb("#1E40AF"))
  v(8pt)
  it
  v(4pt)
}
```

## Text Formatting

```typst
*bold*                           // bold
_italic_                         // italic
*_bold italic_*                  // bold + italic
`monospace`                      // inline code
#underline[underlined text]      // underline
#strike[struck through]          // strikethrough
#smallcaps[Small Capitals]       // small caps
#super[superscript]              // superscript
#sub[subscript]                  // subscript
#text(fill: red)[colored]        // colored text
#text(size: 16pt)[larger]        // sized text
#text(weight: "bold")[bold]      // bold via function
#text(style: "italic")[italic]   // italic via function
#emph[emphasized]                // emphasis (italic)
#strong[strong]                  // strong (bold)
```

## Lists

### Bullet Lists

```typst
- First item
- Second item
  - Nested item
  - Another nested
- Third item
```

### Numbered Lists

```typst
+ First
+ Second
  + Sub-item
+ Third
```

Custom numbering:

```typst
#set enum(numbering: "a)")       // a) b) c)
#set enum(numbering: "(i)")      // (i) (ii) (iii)
#set enum(numbering: "1.a.")     // multi-level: 1.a. 1.b.
```

### Definition Lists

```typst
/ Term: The definition of the term.
/ Another term: Its definition goes here.
```

## Tables

### Basic Table

```typst
#table(
  columns: (1fr, 2fr, 1fr),
  [*Header A*], [*Header B*], [*Header C*],
  [Cell 1], [Cell 2], [Cell 3],
  [Cell 4], [Cell 5], [Cell 6],
)
```

### Column Widths

```typst
columns: (auto, 1fr, 2fr)       // auto-fit, 1 part, 2 parts
columns: (100pt, 1fr)            // fixed + flexible
columns: 3                       // 3 equal columns
```

### Alignment

```typst
#table(
  columns: (1fr, 1fr, 1fr),
  align: (left, center, right),
  // ...
)
```

### Styled Header with Alternating Rows

```typst
#let accent = rgb("#2563EB")

#table(
  columns: (2fr, 1fr, 1fr),
  fill: (_, row) => if row == 0 { accent } else if calc.odd(row) { luma(245) },
  table.header(
    ..([*Name*], [*Qty*], [*Price*]).map(c => text(fill: white, c))
  ),
  [Widget], [10], [$50.00],
  [Gadget], [5], [$75.00],
)
```

### Cell Spanning

```typst
#table(
  columns: 3,
  table.cell(colspan: 3)[*Spanning all 3 columns*],
  [A], [B], [C],
  table.cell(rowspan: 2)[Tall], [D], [E],
  [F], [G],
)
```

### Table Stroke and Inset

```typst
#table(
  columns: 3,
  stroke: 0.5pt + gray,
  inset: 8pt,
  // ...
)
```

## Images and Figures

### Basic Image

```typst
#image("logo.png", width: 50%)
```

### Figure with Caption

```typst
#figure(
  image("chart.png", width: 80%),
  caption: [Quarterly revenue trends for 2024.],
) <fig-revenue>

See @fig-revenue for details.
```

### Image Alignment

```typst
#align(center)[#image("photo.jpg", width: 60%)]
```

## Math

### Inline Math

```typst
The formula $a^2 + b^2 = c^2$ is well known.
```

### Display Math

```typst
$ integral_0^infinity e^(-x^2) dif x = sqrt(pi) / 2 $
```

### Matrices

```typst
$ mat(
  1, 2, 3;
  4, 5, 6;
  7, 8, 9;
) $
```

### Aligned Equations

```typst
$ x &= 2 + 3 \
    &= 5 $
```

## Code Blocks

### Inline Code

```typst
Use the `print()` function.
```

### Code Block with Syntax Highlighting

````typst
```python
def hello():
    print("Hello, world!")
```
````

### Raw Block (No Highlighting)

````typst
```
Plain text code block
```
````

## Headers and Footers

### Simple Page Numbers

```typst
#set page(
  footer: context align(center)[#counter(page).display()],
)
```

### Header with Title and Date, Footer with Page Numbers

```typst
#set page(
  header: context {
    if counter(page).get().first() > 1 [
      _Document Title_
      #h(1fr)
      #datetime.today().display("[month repr:long] [day], [year]")
      #v(-4pt)
      #line(length: 100%, stroke: 0.5pt + gray)
    ]
  },
  footer: context {
    let pg = counter(page).get().first()
    if pg > 1 {
      align(center)[Page #pg]
    }
  },
)
```

### Total Page Count

```typst
#set page(
  footer: context [
    #h(1fr)
    Page #counter(page).display() of #counter(page).final().first()
    #h(1fr)
  ],
)
```

## Columns

```typst
// Whole document
#set page(columns: 2)

// Specific section
#columns(2, gutter: 16pt)[
  Left column content here.

  #colbreak()

  Right column content here.
]
```

## Variables and Functions

### Variables

```typst
#let company = "Acme Corp"
#let accent = rgb("#2563EB")

Welcome to #company!
```

### Functions (Reusable Components)

```typst
#let badge(label, color: gray) = {
  box(
    fill: color.lighten(80%),
    stroke: color + 0.5pt,
    inset: (x: 6pt, y: 3pt),
    radius: 3pt,
  )[#text(fill: color, size: 9pt, weight: "bold")[#label]]
}

Status: #badge("Active", color: green) #badge("Urgent", color: red)
```

## Show Rules

### Global Heading Style

```typst
#show heading: set text(font: "Liberation Sans")
```

### Links Always Blue and Underlined

```typst
#show link: set text(fill: blue)
#show link: underline
```

### Custom Block Quotes

```typst
#show quote.where(block: true): it => {
  block(
    inset: (left: 12pt),
    stroke: (left: 3pt + gray),
  )[#text(style: "italic")[#it.body]]
}
```

## Colors

### Named Colors

```typst
red, blue, green, yellow, orange, purple, black, white, gray
luma(200)                    // grayscale 0-255
```

### Custom Colors

```typst
rgb("#2563EB")               // hex
rgb(37, 99, 235)             // RGB values
color.lighten(40%)           // lighter variant
color.darken(20%)            // darker variant
```

## Spacing

```typst
#v(12pt)                     // vertical space
#h(1fr)                      // horizontal fill (push right)
#h(12pt)                     // horizontal space
~                            // non-breaking space
\                            // line break (in markup mode)
#linebreak()                 // explicit line break
#parbreak()                  // paragraph break
```

## Footnotes

```typst
This claim needs a source.#footnote[See Smith et al., 2024.]
```

## Page Breaks

```typst
#pagebreak()                 // new page
#pagebreak(weak: true)       // only if not already at page start
```

## Outline (Table of Contents)

```typst
#outline(title: "Table of Contents", indent: auto)
```

## Labels and References

```typst
= Introduction <intro>

See @intro for the introduction.
```
