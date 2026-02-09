// Professional Report Template
// Usage: typst compile report.typ report.pdf
// Customize the variables below, then fill in your content.

#let title = "Quarterly Performance Report"
#let author = "Jane Smith"
#let date = datetime.today().display("[month repr:long] [day], [year]")
#let accent = rgb("#2563EB")

// --- Page Setup ---
#set page(
  paper: "us-letter",
  margin: (top: 1in, bottom: 1in, left: 1in, right: 1in),
  header: context {
    if counter(page).get().first() > 1 [
      #text(size: 9pt, fill: gray)[#title #h(1fr) #date]
      #v(-4pt)
      #line(length: 100%, stroke: 0.5pt + luma(200))
    ]
  },
  footer: context {
    let pg = counter(page).get().first()
    if pg > 1 {
      align(center, text(size: 9pt, fill: gray)[Page #pg])
    }
  },
)

// --- Typography ---
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): set text(size: 16pt, fill: accent)
#show heading.where(level: 2): set text(size: 13pt, fill: accent.darken(15%))

// --- Title Page ---
#v(2fr)
#align(center)[
  #text(size: 28pt, weight: "bold", fill: accent)[#title]
  #v(12pt)
  #line(length: 40%, stroke: 1.5pt + accent)
  #v(12pt)
  #text(size: 14pt)[#author]
  #v(4pt)
  #text(size: 12pt, fill: gray)[#date]
]
#v(3fr)
#pagebreak()

// --- Table of Contents ---
#outline(title: "Contents", indent: auto)
#pagebreak()

// --- Content ---
= Executive Summary

This report presents the key performance metrics and strategic initiatives for the quarter. Overall results exceeded expectations across all major business units, with revenue up 12% year-over-year.

#block(
  fill: rgb("#EFF6FF"),
  stroke: accent + 1pt,
  inset: 12pt,
  radius: 4pt,
  width: 100%,
)[
  *Key Highlights:*
  - Revenue grew 12% YoY to \$4.2M
  - Customer retention rate improved to 94%
  - Three new product launches completed on schedule
]

= Performance Metrics

== Revenue by Division

#table(
  columns: (2fr, 1fr, 1fr, 1fr),
  fill: (_, row) => if row == 0 { accent } else if calc.odd(row) { luma(245) },
  table.header(
    ..([*Division*], [*Q3*], [*Q4*], [*Change*]).map(c => text(fill: white, c))
  ),
  [Enterprise], [$1.8M], [$2.1M], [+16.7%],
  [SMB], [$1.2M], [$1.3M], [+8.3%],
  [Consumer], [$0.7M], [$0.8M], [+14.3%],
  [*Total*], [*$3.7M*], [*$4.2M*], [*+13.5%*],
)

== Customer Satisfaction

Customer satisfaction scores remained strong:

- *Enterprise*: 4.6/5.0 (+0.2)
- *SMB*: 4.3/5.0 (+0.1)
- *Consumer*: 4.5/5.0 (+0.3)

= Strategic Initiatives

== Product Roadmap

The team delivered three major releases this quarter:

+ *Platform v3.0* — Complete UI redesign with improved accessibility
+ *Analytics Dashboard* — Real-time metrics and custom reports
+ *Mobile App v2* — Native iOS and Android applications

== Next Quarter Priorities

Looking ahead, the team will focus on:

- International expansion into European markets
- AI-powered recommendation engine
- Enterprise SSO and compliance features

= Appendix

Additional data tables and supporting materials are available upon request.
