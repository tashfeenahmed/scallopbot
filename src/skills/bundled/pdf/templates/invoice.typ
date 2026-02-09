// Invoice Template
// Usage: typst compile invoice.typ invoice.pdf
// Customize the variables below with your data.

#let accent = rgb("#2563EB")
#let light-accent = rgb("#EFF6FF")

#let company-name = "Acme Corporation"
#let company-street = "123 Business Ave, Suite 400"
#let company-city = "San Francisco, CA 94102"
#let company-email = "billing@acme.com"
#let company-phone = "(415) 555-0100"

#let invoice-number = "INV-2025-0042"
#let invoice-date = datetime.today().display("[month repr:long] [day], [year]")
#let due-date = "February 28, 2025"

#let bill-to-name = "GlobalTech Industries"
#let bill-to-contact = "John Williams"
#let bill-to-street = "456 Commerce Blvd"
#let bill-to-city = "New York, NY 10001"

#let items = (
  ("Web Application Development", 80, 150.00),
  ("UI/UX Design Services", 40, 125.00),
  ("Database Architecture", 24, 175.00),
  ("QA Testing & Review", 16, 100.00),
  ("Project Management", 20, 130.00),
)

#let tax-rate = 0.0875  // 8.75%

// --- Computed Values ---
#let subtotal = items.map(item => item.at(1) * item.at(2)).sum()
#let tax = subtotal * tax-rate
#let total = subtotal + tax

// --- Page Setup ---
#set page(paper: "us-letter", margin: (top: 0.75in, bottom: 0.75in, left: 0.75in, right: 0.75in))
#set text(font: "Helvetica Neue", size: 10pt)

// --- Header ---
#grid(
  columns: (1fr, 1fr),
  align: (left, right),
  [
    #text(size: 22pt, weight: "bold", fill: accent)[#company-name]
    #v(4pt)
    #text(size: 9pt, fill: gray)[
      #company-street \
      #company-city \
      #company-email · #company-phone
    ]
  ],
  [
    #text(size: 28pt, weight: "bold", fill: accent)[INVOICE]
    #v(4pt)
    #text(size: 10pt)[
      *Invoice \#:* #invoice-number \
      *Date:* #invoice-date \
      *Due:* #due-date
    ]
  ],
)

#v(8pt)
#line(length: 100%, stroke: 1.5pt + accent)
#v(16pt)

// --- Bill To ---
#grid(
  columns: (1fr, 1fr),
  [
    #text(size: 9pt, fill: gray, weight: "bold")[BILL TO]
    #v(4pt)
    *#bill-to-name* \
    #bill-to-contact \
    #bill-to-street \
    #bill-to-city
  ],
  [],
)

#v(20pt)

// --- Line Items Table ---
#table(
  columns: (3fr, 1fr, 1fr, 1fr),
  inset: 10pt,
  stroke: none,
  fill: (_, row) => if row == 0 { accent } else if calc.odd(row) { luma(248) },
  table.header(
    ..([*Description*], [*Hours*], [*Rate*], [*Amount*]).map(c => text(fill: white, weight: "bold", c))
  ),
  ..items.map(item => {
    let amount = item.at(1) * item.at(2)
    (
      item.at(0),
      align(center)[#item.at(1)],
      align(right)[\$#str(calc.round(item.at(2), digits: 2))],
      align(right)[\$#str(calc.round(amount, digits: 2))],
    )
  }).flatten(),
)

#v(8pt)

// --- Totals ---
#align(right)[
  #block(width: 250pt)[
    #line(length: 100%, stroke: 0.5pt + luma(200))
    #v(4pt)
    #grid(
      columns: (1fr, auto),
      row-gutter: 6pt,
      [Subtotal], align(right)[\$#str(calc.round(subtotal, digits: 2))],
      [Tax (#str(calc.round(tax-rate * 100, digits: 2))%)], align(right)[\$#str(calc.round(tax, digits: 2))],
    )
    #v(4pt)
    #line(length: 100%, stroke: 1pt + accent)
    #v(4pt)
    #grid(
      columns: (1fr, auto),
      text(size: 14pt, weight: "bold", fill: accent)[Total Due],
      align(right, text(size: 14pt, weight: "bold", fill: accent)[\$#str(calc.round(total, digits: 2))]),
    )
  ]
]

#v(1fr)

// --- Footer ---
#line(length: 100%, stroke: 0.5pt + luma(200))
#v(8pt)
#text(size: 9pt, fill: gray)[
  *Payment Instructions* \
  Bank transfer to: Acme Corporation \
  Bank: First National Bank · Account: 1234567890 · Routing: 021000021 \
  Please include invoice number #invoice-number in the payment reference.
  #v(4pt)
  _Thank you for your business!_
]
