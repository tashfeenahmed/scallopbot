// Business Letter Template
// Usage: typst compile letter.typ letter.pdf
// Customize the variables below, then fill in your content.

#let sender-name = "Jane Smith"
#let sender-title = "Director of Operations"
#let sender-company = "Acme Corporation"
#let sender-street = "123 Business Ave, Suite 400"
#let sender-city = "San Francisco, CA 94102"
#let sender-email = "jane.smith@acme.com"
#let sender-phone = "(415) 555-0123"

#let recipient-name = "John Williams"
#let recipient-title = "Head of Procurement"
#let recipient-company = "GlobalTech Industries"
#let recipient-street = "456 Commerce Blvd"
#let recipient-city = "New York, NY 10001"

#let subject = "Partnership Proposal — Q2 2025"

// --- Page Setup ---
#set page(paper: "us-letter", margin: (top: 1in, bottom: 1in, left: 1.25in, right: 1.25in))
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.65em)

// --- Sender Block (Right-Aligned) ---
#align(right)[
  #text(weight: "bold", size: 12pt)[#sender-name] \
  #sender-title \
  #sender-company \
  #sender-street \
  #sender-city \
  #text(size: 10pt, fill: gray)[#sender-email · #sender-phone]
]

#v(16pt)
#line(length: 100%, stroke: 0.5pt + luma(200))
#v(16pt)

// --- Date ---
#datetime.today().display("[month repr:long] [day], [year]")

#v(16pt)

// --- Recipient Block ---
#recipient-name \
#recipient-title \
#recipient-company \
#recipient-street \
#recipient-city

#v(16pt)

// --- Subject Line ---
*Re: #subject*

#v(8pt)

// --- Body ---
Dear Mr. Williams,

Thank you for taking the time to meet with our team last week. Following our discussion, I am writing to formally propose a strategic partnership between Acme Corporation and GlobalTech Industries.

Our analysis suggests that combining our logistics platform with your distribution network would create significant value for both organizations. Specifically, we project:

- *Cost reduction* of 15–20% in supply chain operations
- *Delivery time improvement* of 2–3 business days on average
- *Expanded market reach* across North America and Europe

I have enclosed a detailed proposal document outlining the terms, timeline, and mutual commitments. Our team is prepared to begin the pilot program as early as next quarter.

I would welcome the opportunity to discuss this proposal further at your convenience. Please feel free to reach me directly at #sender-phone or #sender-email.

#v(24pt)

// --- Closing ---
Sincerely,

#v(32pt)

#sender-name \
#sender-title \
#sender-company
