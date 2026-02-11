import * as React from "react"
import {
  Brain,
  Route,
  MessagesSquare,
  Mic,
  Puzzle,
  Moon,
  LayoutDashboard,
  CalendarClock,
  ShieldCheck,
  BookOpen,
  BarChart3,
} from "lucide-react"

const GITHUB_URL = "https://github.com/tashfeenahmed/scallopbot"

const features = [
  {
    icon: Brain,
    title: "Hybrid Memory Engine",
    desc: "BM25 + semantic search with relationship graphs, memory decay, and automatic fact extraction. Your assistant remembers context across every conversation.",
  },
  {
    icon: Route,
    title: "Cost-Aware Model Routing",
    desc: "7 LLM providers with automatic failover. Each request routes to the cheapest capable model \u2014 Groq for speed, Claude for reasoning, GPT-4o for general tasks.",
  },
  {
    icon: MessagesSquare,
    title: "8 Messaging Channels",
    desc: "Telegram, Discord, WhatsApp, Slack, Signal, Matrix, CLI, and REST API. One process, every platform your team uses.",
  },
  {
    icon: Mic,
    title: "Local Voice Pipeline",
    desc: "On-device speech-to-text (faster-whisper) and text-to-speech (Kokoro) at zero API cost. Cloud fallbacks when you need them.",
  },
  {
    icon: Puzzle,
    title: "Skills-Only Architecture",
    desc: "16 bundled skills using the OpenClaw format. Install community skills from ClawHub. No hardcoded tools \u2014 everything is modular.",
  },
  {
    icon: Moon,
    title: "Bio-Inspired Cognition",
    desc: "Dream cycles consolidate memories overnight. Affect detection, self-reflection, and gap scanning create an assistant that genuinely learns.",
  },
  {
    icon: LayoutDashboard,
    title: "Web Dashboard",
    desc: "Real-time chat with markdown rendering and streaming. Debug mode shows tool execution and thinking steps. Built-in cost panel with 14-day spending charts.",
  },
  {
    icon: CalendarClock,
    title: "Proactive Scheduling",
    desc: "Natural language reminders with timezone awareness. Interval, daily, and weekly schedules. Actionable reminders execute autonomously when triggered.",
  },
  {
    icon: ShieldCheck,
    title: "Reliability Built In",
    desc: "Circuit breakers, graceful degradation, and crash recovery with session persistence. Atomic claim guards prevent duplicate execution across restarts.",
  },
]

const providers = [
  { name: "Anthropic", model: "Claude Sonnet", tier: "Complex" },
  { name: "Moonshot", model: "Kimi K2.5", tier: "Cost-effective" },
  { name: "OpenAI", model: "GPT-4o", tier: "General" },
  { name: "xAI", model: "Grok 4", tier: "Real-time" },
  { name: "Groq", model: "Llama 3.3 70B", tier: "Ultra-fast" },
  { name: "Ollama", model: "Local models", tier: "Private" },
  { name: "OpenRouter", model: "100+ models", tier: "Flexible" },
]

const channels = [
  "Telegram", "Discord", "WhatsApp", "Slack",
  "Signal", "Matrix", "CLI", "REST API",
]

const researchDomains = [
  {
    title: "Memory That Evolves",
    body: `ScallopBot retrieves memories through three signals\u2014BM25 keyword matching, semantic embeddings, and a prominence score reflecting each memory\u2019s decay state\u2014then optionally re-ranks the top candidates with an LLM call. This hybrid, retrieve-then-rerank pipeline turns out to be what the field is converging on. A 47-author survey by Hu et al. established multi-signal retrieval as the emerging standard and found that utility-based deletion alone yields up to 10% performance gains. Chhikara et al.\u2019s Mem0 demonstrated 26% accuracy improvement through dynamic extraction and consolidation. Pan et al. showed at ICLR that prompt compression serves as effective denoising for retrieval\u2014the same principle behind our LLM re-ranking stage. On the lifecycle side, Alqithami benchmarked six forgetting policies and found that hybrid forgetting\u2014combining recency, frequency, and importance\u2014achieves a composite score of 0.911, independently validating ScallopBot\u2019s four-factor decay engine. Yang et al.\u2019s taxonomy of graph-based agent memory identifies typed relation graphs with consolidation operations as a key capability, and Li et al.\u2019s MemOS proposes the same unified scheduling and lifecycle management that our three-tier heartbeat implements.`,
    papers: [
      { title: "Memory in the Age of AI Agents: A Survey", id: "2512.13564", cite: "Hu et al., 2025" },
      { title: "Mem0: Scalable Long-Term Memory for AI Agents", id: "2504.19413", cite: "Chhikara et al., 2025" },
      { title: "Memory Construction and Retrieval for Personalized Conversational Agents", cite: "Pan et al., ICLR 2025" },
      { title: "Graph-based Agent Memory", id: "2602.05665", cite: "Yang et al., 2026" },
      { title: "Forgetful but Faithful", id: "2512.12856", cite: "Alqithami, 2025" },
      { title: "MemOS: A Memory OS for AI Systems", id: "2507.03724", cite: "Li et al., 2025" },
    ],
  },
  {
    title: "Cognitive Architecture",
    body: `Between user messages, ScallopBot doesn\u2019t sit idle. A three-tier heartbeat daemon\u2014pulse every five minutes, breath every thirty, deep sleep nightly\u2014drives autonomous cognition: memory decay, fusion, reflection, and dream cycles all run in the background without user prompting. This design draws on the same intellectual lineage as Sumers et al.\u2019s CoALA framework, which argues from SOAR and ACT-R that language agents need autonomous cognitive loops running between interactions. Packer et al.\u2019s MemGPT drew an explicit analogy between LLM agents and operating systems, introducing hierarchical memory tiers and interrupt-driven control flow\u2014an influence on ScallopBot\u2019s background gardener. Shinn et al.\u2019s Reflexion demonstrated that verbal self-reflection achieves 91% pass@1 on HumanEval, validating the pattern ScallopBot uses for nightly SOUL re-distillation and composite reflection. And Zhang et al.\u2019s MemRL showed that agents can evolve through memory processing without weight updates\u2014precisely the mechanism by which ScallopBot improves over time.`,
    papers: [
      { title: "Cognitive Architectures for Language Agents (CoALA)", cite: "Sumers et al., TMLR 2024" },
      { title: "MemGPT: Towards LLMs as Operating Systems", id: "2310.08560", cite: "Packer et al., 2023" },
      { title: "Reflexion: Language Agents with Verbal Reinforcement Learning", cite: "Shinn et al., NeurIPS 2023" },
      { title: "MemRL: Self-Evolving Agents via Runtime RL", id: "2601.03192", cite: "Zhang, S. et al., 2026" },
    ],
  },
  {
    title: "Bio-Inspired Dreaming",
    body: `Every night, ScallopBot dreams. A two-phase cycle mirrors biological sleep: an NREM stage consolidates fragmented memories across topic boundaries into coherent summaries, then a REM stage runs spreading activation with elevated stochastic noise to discover novel associations between memories that have never been explicitly connected. Zhang\u2019s computational account of dreaming provides the direct theoretical grounding\u2014modelling how stochastic hippocampal replay during sleep both consolidates existing knowledge and generates novel learning through controlled randomness. Pavlovi\u0107 et al. validated spreading activation for knowledge-graph retrieval, demonstrating that the same ACT-R-inspired algorithm ScallopBot uses for associative memory surfacing improves retrieval over standard approaches.`,
    papers: [
      { title: "A Computational Account of Dreaming", id: "2602.04095", cite: "Zhang, Q., 2026" },
      { title: "Spreading Activation for Knowledge-Graph RAG", id: "2512.15922", cite: "Pavlovi\u0107 et al., 2025" },
    ],
  },
  {
    title: "Affect Awareness",
    body: `ScallopBot detects emotional tone on every message using an AFINN-165 lexicon with VADER-style heuristics\u2014zero API cost, sub-millisecond latency. Scores are smoothed through a dual exponential moving average: a fast component (2-hour half-life) tracks session mood, while a slow component (3-day half-life) tracks baseline. The divergence between them serves as a distress signal. Critically, affect information is injected into the system prompt as observation only\u2014the agent knows the user seems frustrated but is never instructed to change its reasoning because of it. This affect guard was motivated by Mozikov et al.\u2019s NeurIPS finding that emotional prompting causes measurable behavioural shifts in LLMs, which could introduce systematic bias without safeguards. Lu & Li\u2019s work on dynamic affective memory management introduced the same temporal smoothing principle\u2014Bayesian-inspired updates over time rather than per-message classification. Chandra et al.\u2019s longitudinal study with 149 participants over five weeks provides the empirical case for why emotional awareness matters at all.`,
    papers: [
      { title: "Emotional Decision-Making of LLMs in Strategic Games", cite: "Mozikov et al., NeurIPS 2024" },
      { title: "Dynamic Affective Memory Management", id: "2510.27418", cite: "Lu & Li, 2025" },
      { title: "Longitudinal Study on Social and Emotional Use of AI Agents", id: "2504.14112", cite: "Chandra et al., 2025" },
    ],
  },
  {
    title: "Proactive Intelligence",
    body: `Most assistants wait to be asked. ScallopBot\u2019s gap scanner actively searches for unresolved questions, approaching deadlines, and behavioural anomalies, then uses an LLM to diagnose which gaps deserve attention and how urgently. Delivery is gated by a trust feedback loop: accepted suggestions earn small trust increments, while dismissals subtract more\u2014reflecting the psychological principle that trust builds slowly and breaks quickly. Deng et al.\u2019s comprehensive survey in ACM TOIS established the three core proactive capabilities, while Pasternak\u2019s PROBE framework decomposes proactivity into exactly the search-diagnose-act pipeline that ScallopBot implements. Liu et al.\u2019s Inner Thoughts framework at CHI gave agents continuous covert reasoning in parallel to conversation\u2014directly validating ScallopBot\u2019s post-session inner thoughts with selective surfacing. Sun et al.\u2019s PPP framework demonstrated that jointly optimising productivity, proactivity, and personalisation outperforms GPT-5 by 21.6 points, confirming the value of integrating proactivity with personalisation rather than treating them as separate problems.`,
    papers: [
      { title: "Proactive Conversational AI: A Comprehensive Survey", cite: "Deng et al., ACM TOIS 2025" },
      { title: "Beyond Reactivity: Measuring Proactive Problem Solving", id: "2510.19771", cite: "Pasternak, 2025" },
      { title: "Proactive Conversational Agents with Inner Thoughts", cite: "Liu et al., CHI 2025" },
      { title: "Training Proactive and Personalized LLM Agents", id: "2511.02208", cite: "Sun et al., 2025" },
    ],
  },
]

const benchmarkStats = [
  { value: "0.68", label: "Precision@5", detail: "+45% vs OpenClaw, +79% vs Mem0" },
  { value: "0.90", label: "MRR", detail: "Top result relevant 90% of the time" },
  { value: "$0.06", label: "Daily cost", detail: "Full cognitive pipeline at ~10 LLM calls/day" },
]

const benchmarkMetrics = [
  {
    metric: "Precision@5",
    desc: "Fraction of top-5 results containing ground truth",
    systems: [
      { name: "ScallopBot", value: 0.68, highlight: true, vs: "+45% vs next best" },
      { name: "OpenClaw", value: 0.47 },
      { name: "Mem0", value: 0.38 },
    ],
  },
  {
    metric: "Mean Reciprocal Rank",
    desc: "How high the first relevant result ranks (1.0 = always first)",
    systems: [
      { name: "ScallopBot", value: 0.90, highlight: true, vs: "+20% vs next best" },
      { name: "Mem0", value: 0.75 },
      { name: "OpenClaw", value: 0.65 },
    ],
  },
  {
    metric: "Recall",
    desc: "Fraction of expected facts found anywhere in top-5",
    systems: [
      { name: "ScallopBot", value: 0.85, highlight: true, vs: "+5% vs next best" },
      { name: "OpenClaw", value: 0.81 },
      { name: "Mem0", value: 0.47 },
    ],
  },
]

export default function IndexPage() {
  return (
    <main style={{ margin: 0, padding: 0, fontFamily: "'Cormorant Garamond', 'Garamond', 'Times New Roman', serif", color: "#111", background: "#fff" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700&family=JetBrains+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        html { scroll-behavior: smooth; }

        body { overflow-x: hidden; background: #fff; }

        /* Navbar */
        .navbar {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 100;
          padding: 0.9rem 2.5rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border-bottom: 1px solid #eee;
          transition: all 0.3s;
        }

        .navbar.on-hero {
          background: rgba(255, 255, 255, 0.9);
          border-bottom: 1px solid #eee;
        }

        .nav-brand {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.5rem;
          font-weight: 600;
          color: #111;
          text-decoration: none;
          letter-spacing: 0.01em;
        }

        .navbar.on-hero .nav-brand { color: #111; }

        .nav-links {
          display: flex;
          align-items: center;
          gap: 2.25rem;
          list-style: none;
        }

        .nav-links a {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.05rem;
          font-weight: 500;
          color: #666;
          text-decoration: none;
          transition: color 0.2s;
        }

        .nav-links a:hover { color: #111; }

        .navbar.on-hero .nav-links a { color: #666; }
        .navbar.on-hero .nav-links a:hover { color: #111; }

        .nav-github {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.45rem 1rem;
          background: #111;
          color: #fff !important;
          border-radius: 6px;
          font-size: 0.95rem;
          font-weight: 600;
          transition: all 0.2s;
        }

        .nav-github:hover {
          background: #333;
          transform: translateY(-1px);
        }

        .navbar.on-hero .nav-github {
          background: #111;
          color: #fff !important;
        }

        .navbar.on-hero .nav-github:hover {
          background: #333;
        }

        /* Hero */
        .hero {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 6rem 2rem 4rem;
          background: #fff;
          position: relative;
          overflow: hidden;
        }

        .hero-content { position: relative; z-index: 1; max-width: 780px; }

        .hero-eyebrow {
          display: inline-block;
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.95rem;
          font-weight: 500;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: #999;
          margin-bottom: 2.5rem;
        }

        .hero h1 {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: clamp(3.2rem, 8vw, 5.5rem);
          font-weight: 300;
          line-height: 1.1;
          color: #111;
          margin-bottom: 1.75rem;
          letter-spacing: -0.01em;
        }

        .hero h1 em {
          font-style: italic;
          font-weight: 400;
        }

        .hero-sub {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: clamp(1.15rem, 2.5vw, 1.4rem);
          color: #777;
          line-height: 1.7;
          max-width: 520px;
          margin: 0 auto 3.5rem;
          font-weight: 300;
        }

        .hero-buttons {
          display: flex;
          gap: 1.25rem;
          justify-content: center;
          flex-wrap: wrap;
        }

        .btn-primary {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.8rem 1.75rem;
          background: #111;
          color: #fff;
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.05rem;
          font-weight: 600;
          border-radius: 6px;
          text-decoration: none;
          transition: all 0.2s;
        }

        .btn-primary:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.12);
          background: #333;
        }

        .btn-secondary {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.8rem 1.75rem;
          background: transparent;
          color: #666;
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.05rem;
          font-weight: 500;
          border-radius: 6px;
          text-decoration: none;
          border: 1px solid #ddd;
          transition: all 0.2s;
        }

        .btn-secondary:hover {
          color: #111;
          border-color: #111;
        }

        /* Sections */
        .section {
          padding: 7rem 2rem;
          max-width: 1060px;
          margin: 0 auto;
        }

        .section-label {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.85rem;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #999;
          margin-bottom: 0.75rem;
        }

        .section h2 {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: clamp(2.2rem, 4.5vw, 3rem);
          font-weight: 400;
          letter-spacing: -0.01em;
          line-height: 1.2;
          margin-bottom: 1rem;
          color: #111;
        }

        .section-subtitle {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.15rem;
          color: #777;
          line-height: 1.75;
          max-width: 520px;
          margin-bottom: 3.5rem;
          font-weight: 400;
        }

        /* Features */
        .features-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 1px;
          background: #e5e5e5;
          border: 1px solid #e5e5e5;
        }

        .feature-card {
          padding: 2.25rem;
          background: #fff;
          transition: background 0.2s;
        }

        .feature-card:hover {
          background: #fafafa;
        }

        .feature-icon {
          margin-bottom: 1rem;
          color: #999;
        }

        .feature-card h3 {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.3rem;
          font-weight: 600;
          margin-bottom: 0.7rem;
          color: #111;
        }

        .feature-card p {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.02rem;
          color: #777;
          line-height: 1.7;
        }

        /* Channels section */
        .channels-section {
          background: #fff;
          border-top: 1px solid #e5e5e5;
        }

        .channels-inner {
          max-width: 1060px;
          margin: 0 auto;
          padding: 7rem 2rem;
        }

        .channels-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.6rem;
          margin-top: 2rem;
        }

        .channel-tag {
          padding: 0.5rem 1.2rem;
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1rem;
          font-weight: 500;
          color: #111;
          border: 1px solid #ddd;
          border-radius: 4px;
          transition: all 0.2s;
        }

        .channel-tag:hover {
          border-color: #111;
        }

        /* Providers */
        .providers-section {
          padding: 7rem 2rem;
          background: #fff;
          color: #111;
          border-top: 1px solid #e5e5e5;
        }

        .providers-inner {
          max-width: 1060px;
          margin: 0 auto;
        }

        .providers-section .section-label { color: #999; }
        .providers-section h2 { color: #111; }
        .providers-section .section-subtitle { color: #777; }

        .providers-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 1px;
          background: #e5e5e5;
          border: 1px solid #e5e5e5;
        }

        .provider-card {
          padding: 1.5rem 1rem;
          background: #fff;
          text-align: center;
          transition: background 0.2s;
        }

        .provider-card:hover {
          background: #fafafa;
        }

        .provider-name {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.05rem;
          font-weight: 600;
          color: #111;
          margin-bottom: 0.2rem;
        }

        .provider-model {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.88rem;
          color: #999;
          margin-bottom: 0.5rem;
        }

        .provider-tier {
          display: inline-block;
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.78rem;
          font-weight: 600;
          padding: 0.15rem 0.5rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #777;
          border: 1px solid #ddd;
        }

        /* Quickstart */
        .quickstart {
          padding: 7rem 2rem;
          background: #fff;
          border-top: 1px solid #e5e5e5;
        }

        .quickstart-inner {
          max-width: 1060px;
          margin: 0 auto;
        }

        .code-block {
          background: #fafafa;
          border: 1px solid #e5e5e5;
          border-radius: 4px;
          padding: 2rem;
          overflow-x: auto;
          margin-top: 2rem;
        }

        .code-block code {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.88rem;
          line-height: 1.8;
          color: #333;
        }

        .code-comment { color: #999; }
        .code-cmd { color: #111; font-weight: 500; }
        .code-flag { color: #555; }

        /* CTA */
        .cta {
          padding: 8rem 2rem;
          text-align: center;
          background: #fff;
          border-top: 1px solid #e5e5e5;
        }

        .cta h2 {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: clamp(2.2rem, 5vw, 3.5rem);
          font-weight: 300;
          color: #111;
          margin-bottom: 1rem;
          letter-spacing: -0.01em;
        }

        .cta p {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.15rem;
          color: #777;
          margin-bottom: 2.5rem;
          max-width: 440px;
          margin-left: auto;
          margin-right: auto;
          line-height: 1.75;
          font-weight: 300;
        }

        /* Footer */
        footer {
          padding: 2.5rem 2rem;
          text-align: center;
          background: #fff;
          border-top: 1px solid #e5e5e5;
        }

        footer p {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.95rem;
          color: #999;
        }

        footer a {
          color: #666;
          text-decoration: none;
        }

        footer a:hover { color: #111; }

        /* Divider */
        .divider {
          width: 3rem;
          height: 1px;
          background: #ccc;
          margin: 1.5rem 0 2rem;
        }

        /* Research */
        .research-section {
          padding: 7rem 2rem;
          background: #fff;
          border-top: 1px solid #e5e5e5;
        }

        .research-inner {
          max-width: 1060px;
          margin: 0 auto;
        }

        .research-intro {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.1rem;
          color: #777;
          line-height: 1.75;
          max-width: 640px;
          margin-bottom: 3.5rem;
        }

        .research-domain {
          margin-bottom: 3rem;
          padding-bottom: 3rem;
          border-bottom: 1px solid #f0f0f0;
        }

        .research-domain:last-child {
          border-bottom: none;
          padding-bottom: 0;
        }

        .research-domain-title {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.35rem;
          font-weight: 600;
          color: #111;
          margin-bottom: 1rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .research-body {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.05rem;
          color: #111;
          line-height: 1.8;
          max-width: 780px;
          margin-bottom: 1.25rem;
        }

        .research-papers {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
        }

        .research-paper-tag {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.88rem;
          color: #999;
          padding: 0.3rem 0.75rem;
          border: 1px solid #e5e5e5;
          border-radius: 3px;
          transition: all 0.2s;
        }

        .research-paper-tag:hover {
          border-color: #bbb;
        }

        .research-link {
          color: #666;
          text-decoration: none;
          transition: color 0.2s;
        }

        .research-link:hover {
          color: #111;
        }

        .research-cite {
          color: #999;
        }

        /* Benchmarks */
        .benchmarks-section {
          padding: 7rem 2rem;
          background: #fff;
          border-top: 1px solid #e5e5e5;
        }

        .benchmarks-inner {
          max-width: 1060px;
          margin: 0 auto;
        }

        .benchmarks-intro {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.05rem;
          color: #111;
          line-height: 1.8;
          max-width: 700px;
          margin-bottom: 3rem;
        }

        .benchmarks-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1px;
          background: #e5e5e5;
          border: 1px solid #e5e5e5;
          margin-bottom: 3rem;
        }

        .bench-stat {
          padding: 2rem 1.5rem;
          background: #fff;
          text-align: center;
        }

        .bench-stat-value {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 2.5rem;
          font-weight: 300;
          color: #111;
          line-height: 1;
          margin-bottom: 0.5rem;
        }

        .bench-stat-label {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.95rem;
          font-weight: 600;
          color: #111;
          margin-bottom: 0.25rem;
        }

        .bench-stat-detail {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.85rem;
          color: #999;
        }

        .bench-table-label {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.15rem;
          font-weight: 600;
          color: #111;
          margin-bottom: 1rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        /* (table styles removed — replaced by bar chart visualization) */

        .bench-note {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1rem;
          color: #777;
          line-height: 1.75;
          max-width: 700px;
        }

        .bench-metrics {
          display: grid;
          grid-template-columns: 1fr;
          gap: 2.75rem;
          margin: 2.5rem 0;
        }

        .bench-metric-title {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 1.2rem;
          font-weight: 600;
          color: #111;
          margin-bottom: 0.15rem;
        }

        .bench-metric-desc {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.9rem;
          color: #999;
          margin-bottom: 1rem;
        }

        .bench-bars {
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
        }

        .bench-bar-row {
          display: grid;
          grid-template-columns: 6.5rem 1fr auto;
          align-items: center;
          gap: 0.75rem;
        }

        .bench-bar-name {
          font-family: 'Cormorant Garamond', Garamond, serif;
          font-size: 0.9rem;
          color: #aaa;
          text-align: right;
        }

        .bench-bar-highlight .bench-bar-name {
          color: #111;
          font-weight: 600;
        }

        .bench-bar-track {
          height: 16px;
          background: #f3f3f3;
          border-radius: 8px;
          overflow: hidden;
        }

        .bench-bar-fill {
          height: 100%;
          background: #d8d8d8;
          border-radius: 8px;
          transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .bench-bar-highlight .bench-bar-fill {
          background: #111;
        }

        .bench-bar-val {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.85rem;
          color: #aaa;
          text-align: right;
          min-width: 2.5rem;
        }

        .bench-bar-highlight .bench-bar-val {
          color: #111;
          font-weight: 500;
        }

        .bench-vs {
          display: inline-block;
          margin-top: 0.5rem;
          margin-left: 7.25rem;
          padding: 0.15rem 0.55rem;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          font-weight: 500;
          color: #2e7d32;
          background: #e8f5e9;
          border-radius: 3px;
          letter-spacing: -0.01em;
        }

        /* Mobile */
        @media (max-width: 768px) {
          .nav-links a:not(.nav-github) { display: none; }
          .navbar { padding: 0.75rem 1.5rem; }
          .features-grid { grid-template-columns: 1fr; }
          .benchmarks-stats { grid-template-columns: 1fr; }
          .bench-bar-row { grid-template-columns: 5.5rem 1fr auto; gap: 0.5rem; }
          .bench-bar-name { font-size: 0.8rem; }
          .bench-vs { margin-left: 6rem; }
        }
      `}</style>

      {/* Navbar */}
      <nav className="navbar on-hero" id="navbar">
        <a href="#" className="nav-brand">ScallopBot</a>
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#channels">Channels</a>
          <a href="#providers">Providers</a>
          <a href="#research">Research</a>
          <a href="#benchmarks">Benchmarks</a>
          <a href="#quickstart">Get Started</a>
          <a href={GITHUB_URL} className="nav-github">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            GitHub
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-content">
          <div className="hero-eyebrow">Open Source &middot; MIT License</div>
          <h1>
            Your AI assistant,<br />
            <em>self-hosted.</em>
          </h1>
          <p className="hero-sub">
            Intelligent cost optimization, persistent memory, and multi-channel
            deployment &mdash; all running on your own server.
          </p>
          <div className="hero-buttons">
            <a href={GITHUB_URL} className="btn-primary">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              View on GitHub
            </a>
            <a href="#features" className="btn-secondary">
              Explore features
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="section">
        <div className="section-label">Features</div>
        <h2>Everything you need, nothing you don't</h2>
        <div className="divider" />
        <p className="section-subtitle">
          A complete AI assistant framework built on simplicity, privacy, and cost control.
        </p>
        <div className="features-grid">
          {features.map((f) => {
            const Icon = f.icon
            return (
              <div key={f.title} className="feature-card">
                <div className="feature-icon"><Icon size={22} strokeWidth={1.25} /></div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            )
          })}
        </div>
      </section>

      {/* Channels */}
      <section id="channels" className="channels-section">
        <div className="channels-inner">
          <div className="section-label">Channels</div>
          <h2>One process, every platform</h2>
          <div className="divider" />
          <p className="section-subtitle">
            Connect to 8 messaging platforms simultaneously from a single Node.js process.
          </p>
          <div className="channels-row">
            {channels.map((c) => (
              <span key={c} className="channel-tag">{c}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Providers */}
      <section id="providers" className="providers-section">
        <div className="providers-inner">
          <div className="section-label">Providers</div>
          <h2>7 providers, automatic failover</h2>
          <div className="divider" />
          <p className="section-subtitle">
            Every request routes to the cheapest capable model. When a provider goes down, traffic shifts instantly.
          </p>
          <div className="providers-grid">
            {providers.map((p) => (
              <div key={p.name} className="provider-card">
                <div className="provider-name">{p.name}</div>
                <div className="provider-model">{p.model}</div>
                <span className="provider-tier">{p.tier}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quickstart */}
      <section id="quickstart" className="quickstart">
        <div className="quickstart-inner">
          <div className="section-label">Get Started</div>
          <h2>Up and running in minutes</h2>
          <div className="divider" />
          <p className="section-subtitle">
            One script installs everything on a fresh Ubuntu server. Add a provider key and you're live.
          </p>
          <div className="code-block">
            <code>
              <span className="code-comment"># Clone the repo</span><br />
              <span className="code-cmd">git clone</span> {GITHUB_URL}<br />
              <span className="code-cmd">cd</span> scallopbot<br /><br />
              <span className="code-comment"># One-command server setup (Node 22, PM2, voice deps, Ollama)</span><br />
              <span className="code-cmd">bash</span> scripts/server-install.sh<br /><br />
              <span className="code-comment"># Configure your provider key</span><br />
              <span className="code-cmd">cp</span> .env.example .env<br />
              <span className="code-cmd">nano</span> .env &nbsp;<span className="code-comment"># add at least ANTHROPIC_API_KEY</span><br /><br />
              <span className="code-comment"># Build and start</span><br />
              <span className="code-cmd">npm run build</span><br />
              <span className="code-cmd">node</span> dist/cli.js <span className="code-flag">start</span>
            </code>
          </div>
        </div>
      </section>

      {/* Research */}
      <section id="research" className="research-section">
        <div className="research-inner">
          <div className="section-label">Research</div>
          <h2>Built on research, not hunches</h2>
          <div className="divider" />
          <p className="research-intro">
            ScallopBot's architecture independently converged on patterns validated
            by recent work from ICLR, NeurIPS, CHI, and ACM TOIS. Below is how each
            subsystem connects to the literature.
          </p>
          {researchDomains.map((d) => (
            <div key={d.title} className="research-domain">
              <div className="research-domain-title">
                <BookOpen size={16} strokeWidth={1.25} />
                {d.title}
              </div>
              <p className="research-body">{d.body}</p>
              <div className="research-papers">
                {d.papers.map((p) => (
                  <span key={p.title} className="research-paper-tag">
                    {p.id ? (
                      <a
                        href={`https://arxiv.org/abs/${p.id}`}
                        className="research-link"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {p.cite}
                      </a>
                    ) : (
                      <span className="research-cite">{p.cite}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Benchmarks */}
      <section id="benchmarks" className="benchmarks-section">
        <div className="benchmarks-inner">
          <div className="section-label">Benchmarks</div>
          <h2>30-day cognitive pipeline evaluation</h2>
          <div className="divider" />
          <p className="benchmarks-intro">
            We ran a 30-day benchmark with real providers (Ollama embeddings,
            Moonshot LLM) across three architectures: OpenClaw, Mem0, and
            ScallopBot. Each started from identical empty state with its own
            search algorithm. ScallopBot&rsquo;s prominence-weighted hybrid
            retrieval with LLM reranking pulls ahead from Day&nbsp;5 and the gap
            widens over time &mdash; the cognitive pipeline (fusion, reflection,
            gap scanning) creates compounding advantages that grow with scale.
          </p>

          <div className="benchmarks-stats">
            {benchmarkStats.map((s) => (
              <div key={s.label} className="bench-stat">
                <div className="bench-stat-value">{s.value}</div>
                <div className="bench-stat-label">{s.label}</div>
                <div className="bench-stat-detail">{s.detail}</div>
              </div>
            ))}
          </div>

          <div className="bench-table-label">
            <BarChart3 size={16} strokeWidth={1.25} />
            Day 30 Results
          </div>
          <div className="bench-metrics">
            {benchmarkMetrics.map((m) => (
              <div key={m.metric}>
                <div className="bench-metric-title">{m.metric}</div>
                <div className="bench-metric-desc">{m.desc}</div>
                <div className="bench-bars">
                  {m.systems.map((s) => (
                    <div key={s.name} className={`bench-bar-row${s.highlight ? ' bench-bar-highlight' : ''}`}>
                      <div className="bench-bar-name">{s.name}</div>
                      <div className="bench-bar-track">
                        <div className="bench-bar-fill" style={{ width: `${s.value * 100}%` }} />
                      </div>
                      <div className="bench-bar-val">{s.value.toFixed(2)}</div>
                    </div>
                  ))}
                </div>
                {m.systems[0].vs && <div className="bench-vs">{m.systems[0].vs}</div>}
              </div>
            ))}
          </div>
          <p className="bench-note">
            30-day benchmark with real embeddings (Ollama nomic-embed-text) and
            real LLM (Moonshot kimi-k2.5). ScallopBot&rsquo;s cognitive
            pipeline &mdash; memory fusion, reflection, SOUL distillation, gap
            scanning &mdash; creates compounding retrieval advantages that widen
            over time.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="cta">
        <h2>Own your AI assistant</h2>
        <p>
          MIT licensed. Self-hosted. No vendor lock-in.
        </p>
        <a href={GITHUB_URL} className="btn-primary">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          Get Started on GitHub
        </a>
      </section>

      {/* Footer */}
      <footer>
        <p>
          ScallopBot &mdash; MIT License &mdash; <a href={GITHUB_URL}>GitHub</a>
        </p>
      </footer>

      {/* Navbar scroll behavior */}
      <script dangerouslySetInnerHTML={{ __html: `
        (function() {
          var hero = document.querySelector('.hero');
          var navbar = document.getElementById('navbar');
          if (!hero || !navbar) return;
          var observer = new IntersectionObserver(function(entries) {
            navbar.classList.toggle('on-hero', entries[0].isIntersecting);
          }, { threshold: 0.1 });
          observer.observe(hero);
        })();
      `}} />
    </main>
  )
}

export const Head = () => (
  <>
    <title>ScallopBot — Self-hosted AI Assistant</title>
    <meta name="description" content="Self-hosted AI assistant with intelligent cost optimization, persistent memory, and multi-channel deployment." />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
  </>
)
