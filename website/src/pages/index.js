import * as React from "react"
import logo from "../images/logo.png"
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
  BarChart3,
} from "lucide-react"

const GITHUB_URL = "https://github.com/tashfeenahmed/scallopbot"

/* ── SVG diagram constants ── */
const MF = "'JetBrains Mono',monospace"
const G = "#66bb6a"
const GF = "rgba(102,187,106,0.08)"

/* Arrow defs — each SVG needs its own to avoid cross-SVG reference bugs */
function adefs(n) {
  return (
    <defs>
      <marker id={`a${n}`} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0 0L10 5L0 10z" fill="#555" />
      </marker>
      <marker id={`ag${n}`} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0 0L10 5L0 10z" fill={G} />
      </marker>
    </defs>
  )
}

function dbox(x, y, w, h, label, sub, hl) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={5}
        fill={hl ? GF : "#1a1a1a"} stroke={hl ? G : "#333"} strokeWidth={hl ? 1.5 : 1} />
      <text x={x + w / 2} y={sub ? y + h * 0.38 : y + h / 2}
        textAnchor="middle" dominantBaseline="middle"
        fill={hl ? G : "#ccc"} fontSize={11} fontWeight={500} fontFamily={MF}>{label}</text>
      {sub && <text x={x + w / 2} y={y + h * 0.68}
        textAnchor="middle" dominantBaseline="middle"
        fill="#666" fontSize={9} fontFamily={MF}>{sub}</text>}
    </g>
  )
}

function dlbl(x, y, text, hl, size) {
  return <text x={x} y={y} textAnchor="middle" dominantBaseline="middle"
    fill={hl ? G : "#777"} fontSize={size || 10.5} fontWeight={hl ? 500 : 400} fontFamily={MF}>{text}</text>
}

function darr(x1, y1, x2, y2, hl, n) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2}
    stroke={hl ? G : "#555"} strokeWidth={1.5} markerEnd={hl ? `url(#ag${n})` : `url(#a${n})`} />
}

function dline(x1, y1, x2, y2) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#444" strokeWidth={1} />
}

/* ── 9 SVG diagrams ── */
const DIAGRAMS = [
  /* 0 — Hybrid Memory: 3 retrieval paths → reranker → top-k */
  <svg key="d0" viewBox="0 0 380 240" fill="none">
    {adefs(0)}
    {dlbl(190, 14, "query", true, 12)}
    {darr(190, 23, 190, 42, false, 0)}
    {dbox(10, 46, 108, 46, "BM25", "keyword", true)}
    {dbox(136, 46, 108, 46, "Semantic", "embedding", true)}
    {dbox(262, 46, 108, 46, "Graph", "relations", true)}
    {dline(64, 92, 190, 124)}
    {dline(190, 92, 190, 124)}
    {dline(316, 92, 190, 124)}
    {/* Animated dots flowing along edges */}
    <circle r={3} fill={G} opacity={0.8}>
      <animateMotion dur="2s" repeatCount="indefinite" path="M64,92 L190,124" />
    </circle>
    <circle r={3} fill={G} opacity={0.8}>
      <animateMotion dur="2s" repeatCount="indefinite" begin="0.3s" path="M190,92 L190,124" />
    </circle>
    <circle r={3} fill={G} opacity={0.8}>
      <animateMotion dur="2s" repeatCount="indefinite" begin="0.6s" path="M316,92 L190,124" />
    </circle>
    {dbox(115, 128, 150, 46, "Reranker", "LLM-scored", true)}
    {darr(190, 174, 190, 200, true, 0)}
    {dlbl(190, 220, "top-k results", true, 12)}
  </svg>,

  /* 1 — Model Routing: request → router → 3 tiers → cheapest */
  <svg key="d1" viewBox="0 0 380 275" fill="none">
    {adefs(1)}
    {dlbl(190, 14, "request", false, 12)}
    {darr(190, 23, 190, 42, false, 1)}
    {dbox(115, 46, 150, 44, "Router", "classify task", true)}
    {dline(150, 90, 64, 120)}
    {dline(190, 90, 190, 120)}
    {dline(230, 90, 316, 120)}
    <g>
      <rect x={10} y={124} width={108} height={56} rx={5} fill="#1a1a1a" stroke="#333" strokeWidth={1} />
      <text x={64} y={140} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={10} fontWeight={500} fontFamily={MF}>$0.01</text>
      <text x={64} y={155} textAnchor="middle" dominantBaseline="middle" fill="#ccc" fontSize={11} fontWeight={500} fontFamily={MF}>Groq</text>
      <text x={64} y={169} textAnchor="middle" dominantBaseline="middle" fill="#666" fontSize={9} fontFamily={MF}>speed</text>
    </g>
    <g>
      <rect x={136} y={124} width={108} height={56} rx={5} fill="#1a1a1a" stroke="#333" strokeWidth={1} />
      <text x={190} y={140} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={10} fontWeight={500} fontFamily={MF}>$0.05</text>
      <text x={190} y={155} textAnchor="middle" dominantBaseline="middle" fill="#ccc" fontSize={11} fontWeight={500} fontFamily={MF}>Moonshot</text>
      <text x={190} y={169} textAnchor="middle" dominantBaseline="middle" fill="#666" fontSize={9} fontFamily={MF}>balance</text>
    </g>
    <g>
      <rect x={262} y={124} width={108} height={56} rx={5} fill="#1a1a1a" stroke="#333" strokeWidth={1} />
      <text x={316} y={140} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={10} fontWeight={500} fontFamily={MF}>$0.15</text>
      <text x={316} y={155} textAnchor="middle" dominantBaseline="middle" fill="#ccc" fontSize={11} fontWeight={500} fontFamily={MF}>Claude</text>
      <text x={316} y={169} textAnchor="middle" dominantBaseline="middle" fill="#666" fontSize={9} fontFamily={MF}>reasoning</text>
    </g>
    {dline(64, 180, 190, 215)}
    {dline(190, 180, 190, 215)}
    {dline(316, 180, 190, 215)}
    {darr(190, 215, 190, 235, true, 1)}
    {dlbl(190, 255, "cheapest capable", true, 12)}
  </svg>,

  /* 2 — Channels: hub-and-spoke */
  <svg key="d2" viewBox="0 0 380 320" fill="none">
    {/* Lines first (behind nodes) */}
    {[[190,55],[271,89],[305,160],[271,231],[190,265],[109,231],[75,160],[109,89]].map(([x,y],i) =>
      <line key={`cl${i}`} x1={190} y1={160} x2={x} y2={y} stroke="#333" strokeWidth={1} />
    )}
    {/* Center node */}
    <rect x={146} y={142} width={88} height={36} rx={18} fill={GF} stroke={G} strokeWidth={1.5} />
    <text x={190} y={160} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={10} fontWeight={500} fontFamily={MF}>ScallopBot</text>
    {/* Channel nodes */}
    {[
      [190,55,"Telegram"],[271,89,"Discord"],[305,160,"WhatsApp"],[271,231,"Slack"],
      [190,265,"Signal"],[109,231,"Matrix"],[75,160,"CLI"],[109,89,"REST API"],
    ].map(([cx,cy,name]) =>
      <g key={name}>
        <rect x={cx-40} y={cy-14} width={80} height={28} rx={14}
          fill="#1a1a1a" stroke="#444" strokeWidth={1} />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle"
          fill="#ccc" fontSize={9.5} fontWeight={500} fontFamily={MF}>{name}</text>
      </g>
    )}
  </svg>,

  /* 3 — Voice Pipeline: horizontal flow with cloud fallback */
  <svg key="d3" viewBox="0 0 430 185" fill="none">
    {adefs(3)}
    {/* Main pipeline */}
    <circle cx={22} cy={52} r={14} fill="none" stroke="#555" strokeWidth={1} />
    <text x={22} y={52} textAnchor="middle" dominantBaseline="middle" fill="#888" fontSize={7} fontFamily={MF}>audio</text>
    {darr(36, 52, 60, 52, false, 3)}
    {dbox(62, 28, 82, 48, "STT", "whisper", true)}
    {darr(144, 52, 168, 52, false, 3)}
    {dbox(170, 28, 82, 48, "LLM", "reason", true)}
    {darr(252, 52, 276, 52, false, 3)}
    {dbox(278, 28, 82, 48, "TTS", "kokoro", true)}
    {darr(360, 52, 384, 52, false, 3)}
    <circle cx={400} cy={52} r={14} fill="none" stroke="#555" strokeWidth={1} />
    <text x={400} y={52} textAnchor="middle" dominantBaseline="middle" fill="#888" fontSize={7} fontFamily={MF}>audio</text>
    {/* Cloud fallback */}
    <line x1={211} y1={76} x2={211} y2={110} stroke="#555" strokeWidth={1} strokeDasharray="4 3" />
    <rect x={136} y={114} width={150} height={40} rx={5} fill="#1a1a1a" stroke="#444" strokeWidth={1} strokeDasharray="4 3" />
    <text x={211} y={129} textAnchor="middle" dominantBaseline="middle" fill="#888" fontSize={10} fontWeight={500} fontFamily={MF}>Cloud Fallback</text>
    <text x={211} y={145} textAnchor="middle" dominantBaseline="middle" fill="#555" fontSize={8} fontFamily={MF}>if local unavailable</text>
  </svg>,

  /* 4 — Skills Architecture: core engine + modular slots + ClawHub */
  <svg key="d4" viewBox="0 0 380 225" fill="none">
    {adefs(4)}
    {dbox(15, 8, 350, 44, "Core Engine", "router \u00b7 memory \u00b7 scheduling", true)}
    {darr(60, 52, 60, 72, false, 4)}
    {darr(152, 52, 152, 72, false, 4)}
    {darr(244, 52, 244, 72, false, 4)}
    {darr(336, 52, 336, 72, false, 4)}
    {dbox(15, 76, 90, 44, "web", "skill", true)}
    {dbox(107, 76, 90, 44, "calc", "skill", true)}
    {dbox(199, 76, 90, 44, "remind", "skill", true)}
    {dbox(291, 76, 90, 44, "img", "skill", true)}
    {dbox(90, 165, 200, 44, "ClawHub", "community skill registry", true)}
    {darr(190, 165, 190, 140, true, 4)}
    {dlbl(190, 148, "install", true, 9)}
  </svg>,

  /* 5 — Bio-Inspired Cognition: day/night columns */
  <svg key="d5" viewBox="0 0 400 245" fill="none">
    {adefs(5)}
    {/* Column headers */}
    {dlbl(90, 14, "DAY", true, 12)}
    {dlbl(310, 14, "NIGHT", true, 12)}
    {/* Day column */}
    {dbox(10, 30, 160, 48, "Pulse", "every 5m \u00b7 decay tick", true)}
    {dbox(10, 90, 160, 48, "Breath", "every 30m \u00b7 reflection", false)}
    {dbox(10, 150, 160, 48, "Deep Sleep", "nightly \u00b7 SOUL sync", false)}
    {/* Night column */}
    {dbox(230, 30, 160, 68, "NREM", "consolidate \u00b7 fuse topics", true)}
    {dbox(230, 110, 160, 68, "REM", "spreading activation", true)}
    {/* Cross arrow */}
    {darr(170, 174, 230, 64, true, 5)}
    {dlbl(196, 125, "sleep", false, 9)}
    {/* Output */}
    {darr(310, 178, 310, 210, true, 5)}
    {dlbl(310, 228, "novel links", true, 11)}
  </svg>,

  /* 6 — Web Dashboard: browser window mockup */
  <svg key="d6" viewBox="0 0 400 250" fill="none">
    {/* Window frame */}
    <rect x={0} y={0} width={400} height={250} rx={8} fill="#1a1a1a" stroke="#333" strokeWidth={1} />
    {/* Title bar */}
    <rect x={0} y={0} width={400} height={30} rx={8} fill="#252525" />
    <rect x={0} y={22} width={400} height={8} fill="#252525" />
    <circle cx={16} cy={15} r={5} fill="#ff5f57" />
    <circle cx={32} cy={15} r={5} fill="#febc2e" />
    <circle cx={48} cy={15} r={5} fill="#28c840" />
    <text x={200} y={15} textAnchor="middle" dominantBaseline="middle" fill="#888" fontSize={10} fontWeight={500} fontFamily={MF}>ScallopBot Dashboard</text>
    {/* Column dividers */}
    <line x1={200} y1={30} x2={200} y2={218} stroke="#333" strokeWidth={1} />
    <line x1={300} y1={30} x2={300} y2={218} stroke="#333" strokeWidth={1} />
    {/* Column headers */}
    <text x={100} y={46} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={10} fontWeight={500} fontFamily={MF}>Chat</text>
    <text x={250} y={46} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={10} fontWeight={500} fontFamily={MF}>Debug</text>
    <text x={350} y={46} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={10} fontWeight={500} fontFamily={MF}>Cost</text>
    <line x1={0} y1={56} x2={400} y2={56} stroke="#333" strokeWidth={0.5} />
    {/* Chat content */}
    <text x={16} y={74} dominantBaseline="middle" fill="#888" fontSize={9} fontFamily={MF}>&gt; hello</text>
    <text x={16} y={94} dominantBaseline="middle" fill="#666" fontSize={9} fontFamily={MF}>Hi! How can</text>
    <text x={16} y={108} dominantBaseline="middle" fill="#666" fontSize={9} fontFamily={MF}>I help you?</text>
    <text x={16} y={132} dominantBaseline="middle" fill="#888" fontSize={9} fontFamily={MF}>&gt; remind me to...</text>
    <text x={16} y={152} dominantBaseline="middle" fill="#666" fontSize={9} fontFamily={MF}>Done! I'll remind</text>
    <text x={16} y={166} dominantBaseline="middle" fill="#666" fontSize={9} fontFamily={MF}>you tomorrow at 9am.</text>
    {/* Debug content */}
    <text x={210} y={74} dominantBaseline="middle" fill="#666" fontSize={8.5} fontFamily={MF}>tool: web_search</text>
    <text x={210} y={90} dominantBaseline="middle" fill="#666" fontSize={8.5} fontFamily={MF}>think: analyzing...</text>
    <text x={210} y={106} dominantBaseline="middle" fill="#666" fontSize={8.5} fontFamily={MF}>mem: 3 recalled</text>
    <text x={210} y={122} dominantBaseline="middle" fill="#666" fontSize={8.5} fontFamily={MF}>t: 1.2s</text>
    {/* Cost content */}
    <text x={350} y={74} textAnchor="middle" dominantBaseline="middle" fill="#ccc" fontSize={16} fontWeight={300} fontFamily={MF}>$0.06</text>
    <text x={350} y={92} textAnchor="middle" dominantBaseline="middle" fill="#666" fontSize={8} fontFamily={MF}>today</text>
    {/* Mini chart bars */}
    {[108,118,128,138,148,158,168].map((y,i) =>
      <rect key={`b${i}`} x={318} y={y} width={[24,18,32,22,28,20,26][i]} height={6} rx={3} fill={i === 6 ? G : "#444"} />
    )}
    {/* Input bar */}
    <rect x={0} y={218} width={400} height={32} fill="#222" />
    <rect x={0} y={242} width={400} height={8} rx={8} fill="#222" />
    <text x={16} y={234} dominantBaseline="middle" fill="#555" fontSize={9} fontFamily={MF}>type a message...</text>
    <rect x={348} y={224} width={40} height={20} rx={4} fill={G} />
    <text x={368} y={234} textAnchor="middle" dominantBaseline="middle" fill="#111" fontSize={8} fontWeight={600} fontFamily={MF}>send</text>
  </svg>,

  /* 7 — Proactive Scheduling: gap scan → diagnose → trust gate → branch */
  <svg key="d7" viewBox="0 0 380 295" fill="none">
    {adefs(7)}
    {dlbl(160, 14, "memories + context", false, 11)}
    {darr(160, 23, 160, 42, false, 7)}
    {dbox(60, 46, 200, 48, "Gap Scanner", "unresolved \u00b7 deadlines", true)}
    {darr(160, 94, 160, 114, false, 7)}
    {dbox(60, 118, 200, 48, "Diagnose", "LLM judges relevance", true)}
    {darr(160, 166, 160, 186, false, 7)}
    {dbox(60, 190, 200, 48, "Trust Gate", "score > threshold", true)}
    {/* Yes branch → right */}
    {darr(260, 214, 310, 214, true, 7)}
    <rect x={314} y={200} width={60} height={28} rx={5} fill={GF} stroke={G} strokeWidth={1.5} />
    <text x={344} y={214} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={9.5} fontWeight={500} fontFamily={MF}>surface</text>
    <text x={290} y={206} textAnchor="middle" dominantBaseline="middle" fill={G} fontSize={8} fontFamily={MF}>yes</text>
    {/* No branch → down */}
    {darr(160, 238, 160, 260, false, 7)}
    {dlbl(160, 278, "suppress", false, 11)}
    <text x={172} y={252} dominantBaseline="middle" fill="#777" fontSize={8} fontFamily={MF}>no</text>
  </svg>,

  /* 8 — Reliability: circuit breaker state machine */
  <svg key="d8" viewBox="0 0 400 215" fill="none">
    {adefs(8)}
    {/* Three states */}
    {dbox(10, 55, 110, 50, "CLOSED", "pass requests", true)}
    {dbox(145, 55, 110, 50, "OPEN", "block all", false)}
    {dbox(280, 55, 110, 50, "HALF-OPEN", "try one req", false)}
    {/* CLOSED → OPEN */}
    {darr(120, 80, 145, 80, false, 8)}
    {dlbl(132, 50, "failures > N", false, 8)}
    {/* OPEN → HALF-OPEN */}
    {darr(255, 80, 280, 80, false, 8)}
    {dlbl(267, 50, "timeout", false, 8)}
    {/* HALF-OPEN → CLOSED (success, curved above) */}
    <path d="M335 55 L335 28 L65 28 L65 55" stroke={G} strokeWidth={1.5} fill="none" markerEnd={`url(#ag8)`} />
    {dlbl(200, 18, "success", true, 9)}
    {/* HALF-OPEN → OPEN (failure, curved below) */}
    <path d="M310 105 L310 132 L220 132 L220 105" stroke="#555" strokeWidth={1.5} fill="none" markerEnd={`url(#a8)`} />
    {dlbl(265, 142, "failure", false, 9)}
    {/* Crash recovery */}
    <line x1={40} y1={175} x2={360} y2={175} stroke="#333" strokeWidth={0.5} />
    {dlbl(70, 195, "crash", false, 10)}
    {darr(95, 195, 140, 195, true, 8)}
    {dlbl(170, 195, "recover", true, 10)}
    {darr(200, 195, 240, 195, true, 8)}
    {dlbl(310, 195, "replay session", true, 10)}
  </svg>,
]

/* ── Data ── */
const capabilities = [
  {
    icon: Brain,
    title: "Hybrid Memory Engine",
    desc: "BM25 + semantic search with relationship graphs, memory decay, and automatic fact extraction. Your assistant remembers context across every conversation.",
    research: "ScallopBot retrieves memories through three signals\u2014BM25 keyword matching, semantic embeddings, and a prominence score reflecting each memory\u2019s decay state\u2014then re-ranks the top candidates with an LLM call. This hybrid, retrieve-then-rerank pipeline is what the field is converging on.",
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
    icon: Route,
    title: "Cost-Aware Model Routing",
    desc: "7 LLM providers with automatic failover. Each request routes to the cheapest capable model \u2014 Groq for speed, Claude for reasoning, GPT-4o for general tasks.",
    research: null,
    papers: null,
  },
  {
    icon: MessagesSquare,
    title: "8 Messaging Channels",
    desc: "Telegram, Discord, WhatsApp, Slack, Signal, Matrix, CLI, and REST API. One process, every platform your team uses.",
    research: null,
    papers: null,
  },
  {
    icon: Mic,
    title: "Local Voice Pipeline",
    desc: "On-device speech-to-text (faster-whisper) and text-to-speech (Kokoro) at zero API cost. Cloud fallbacks when you need them.",
    research: null,
    papers: null,
  },
  {
    icon: Puzzle,
    title: "Skills-Only Architecture",
    desc: "16 bundled skills using the OpenClaw format. Install community skills from ClawHub. No hardcoded tools \u2014 everything is modular.",
    research: null,
    papers: null,
  },
  {
    icon: Moon,
    title: "Bio-Inspired Cognition",
    desc: "Dream cycles consolidate memories overnight. Affect detection, self-reflection, and gap scanning create an assistant that genuinely learns.",
    research: "A three-tier heartbeat\u2014pulse, breath, deep sleep\u2014drives autonomous cognition between interactions. Nightly dream cycles mirror biological sleep: NREM consolidation followed by REM associative discovery. Affect detection uses AFINN-165 with dual exponential smoothing to track emotional state without biasing reasoning.",
    papers: [
      { title: "Cognitive Architectures for Language Agents (CoALA)", cite: "Sumers et al., TMLR 2024" },
      { title: "MemGPT: Towards LLMs as Operating Systems", id: "2310.08560", cite: "Packer et al., 2023" },
      { title: "Reflexion: Language Agents with Verbal Reinforcement Learning", cite: "Shinn et al., NeurIPS 2023" },
      { title: "MemRL: Self-Evolving Agents via Runtime RL", id: "2601.03192", cite: "Zhang, S. et al., 2026" },
      { title: "A Computational Account of Dreaming", id: "2602.04095", cite: "Zhang, Q., 2026" },
      { title: "Spreading Activation for Knowledge-Graph RAG", id: "2512.15922", cite: "Pavlovi\u0107 et al., 2025" },
      { title: "Emotional Decision-Making of LLMs in Strategic Games", cite: "Mozikov et al., NeurIPS 2024" },
      { title: "Dynamic Affective Memory Management", id: "2510.27418", cite: "Lu & Li, 2025" },
      { title: "Longitudinal Study on Social and Emotional Use of AI Agents", id: "2504.14112", cite: "Chandra et al., 2025" },
    ],
  },
  {
    icon: LayoutDashboard,
    title: "Web Dashboard",
    desc: "Real-time chat with markdown rendering and streaming. Debug mode shows tool execution and thinking steps. Built-in cost panel with 14-day spending charts.",
    research: null,
    papers: null,
  },
  {
    icon: CalendarClock,
    title: "Proactive Scheduling",
    desc: "Natural language reminders with timezone awareness. Interval, daily, and weekly schedules. Actionable reminders execute autonomously when triggered.",
    research: "ScallopBot\u2019s gap scanner actively searches for unresolved questions and approaching deadlines, then diagnoses which gaps deserve attention. Delivery is gated by an asymmetric trust loop\u2014accepted suggestions earn small increments, dismissals subtract more\u2014reflecting how trust builds slowly and breaks quickly.",
    papers: [
      { title: "Proactive Conversational AI: A Comprehensive Survey", cite: "Deng et al., ACM TOIS 2025" },
      { title: "Beyond Reactivity: Measuring Proactive Problem Solving", id: "2510.19771", cite: "Pasternak, 2025" },
      { title: "Proactive Conversational Agents with Inner Thoughts", cite: "Liu et al., CHI 2025" },
      { title: "Training Proactive and Personalized LLM Agents", id: "2511.02208", cite: "Sun et al., 2025" },
    ],
  },
  {
    icon: ShieldCheck,
    title: "Reliability Built In",
    desc: "Circuit breakers, graceful degradation, and crash recovery with session persistence. Atomic claim guards prevent duplicate execution across restarts.",
    research: null,
    papers: null,
  },
]

const providers = [
  { name: "Anthropic", tier: "Complex" },
  { name: "Moonshot", tier: "Cost-effective" },
  { name: "OpenAI", tier: "General" },
  { name: "xAI", tier: "Real-time" },
  { name: "Groq", tier: "Ultra-fast" },
  { name: "Ollama", tier: "Private" },
  { name: "OpenRouter", tier: "Flexible" },
]

const channels = [
  "Telegram", "Discord", "WhatsApp", "Slack",
  "Signal", "Matrix", "CLI", "REST API",
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

function NeuralMesh() {
  const canvasRef = React.useRef(null)
  const mouse = React.useRef({ x: -9999, y: -9999 })
  const nodes = React.useRef([])
  const raf = React.useRef(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    const box = canvas.parentElement
    let cw, ch, edgeDist

    const REVEAL_R = 250

    const OUTLINE = [
      [0.10, 0.60], [0.06, 0.50], [0.03, 0.40], [0.02, 0.28],
      [0.05, 0.18], [0.12, 0.10], [0.22, 0.05], [0.34, 0.02],
      [0.46, 0.01], [0.58, 0.03], [0.68, 0.08], [0.76, 0.16],
      [0.82, 0.26], [0.84, 0.36], [0.82, 0.44], [0.86, 0.52],
      [0.84, 0.62], [0.78, 0.68], [0.70, 0.72], [0.66, 0.80],
      [0.60, 0.76], [0.54, 0.68], [0.42, 0.64], [0.30, 0.62],
      [0.18, 0.61], [0.10, 0.60],
    ]

    function inside(px, py) {
      let c = false
      for (let i = 0, j = OUTLINE.length - 1; i < OUTLINE.length; j = i++) {
        const [xi, yi] = OUTLINE[i], [xj, yj] = OUTLINE[j]
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c
      }
      return c
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1
      cw = box.clientWidth
      ch = box.clientHeight
      canvas.width = cw * dpr
      canvas.height = ch * dpr
      canvas.style.width = cw + "px"
      canvas.style.height = ch + "px"
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function seed() {
      const scale = Math.min(cw * 0.85, ch * 0.9)
      edgeDist = scale * 0.08
      const ox = (cw - scale) / 2
      const oy = (ch - scale * 0.82) / 2
      const pts = []

      for (let i = 0; i < OUTLINE.length - 1; i++) {
        const [x1, y1] = OUTLINE[i]
        const [x2, y2] = OUTLINE[i + 1]
        const seg = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) * scale
        const steps = Math.max(2, Math.round(seg / (edgeDist * 0.55)))
        for (let s = 0; s < steps; s++) {
          const t = s / steps
          pts.push({
            bx: ox + (x1 + (x2 - x1) * t) * scale,
            by: oy + (y1 + (y2 - y1) * t) * scale * 0.82,
          })
        }
      }

      const minD2 = (edgeDist * 0.35) * (edgeDist * 0.35)
      let attempts = 0
      const target = pts.length + 110
      while (pts.length < target && attempts < 6000) {
        const px = Math.random()
        const py = Math.random()
        if (inside(px, py)) {
          const bx = ox + px * scale
          const by = oy + py * scale * 0.82
          let ok = true
          for (const p of pts) {
            if ((p.bx - bx) ** 2 + (p.by - by) ** 2 < minD2) { ok = false; break }
          }
          if (ok) pts.push({ bx, by })
        }
        attempts++
      }

      nodes.current = pts.map(p => ({
        bx: p.bx, by: p.by, x: p.bx, y: p.by,
        r: 1.5 + Math.random() * 1.2,
        phase: Math.random() * Math.PI * 2,
      }))
    }

    function frame(t) {
      ctx.clearRect(0, 0, cw, ch)
      const rect = canvas.getBoundingClientRect()
      const mx = mouse.current.x - rect.left
      const my = mouse.current.y - rect.top
      const pts = nodes.current

      for (const n of pts) {
        n.x = n.bx + Math.sin(t * 0.0008 + n.phase) * 3.5
        n.y = n.by + Math.cos(t * 0.0006 + n.phase * 1.3) * 3.5
      }

      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x
          const dy = pts[i].y - pts[j].y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < edgeDist) {
            const ex = (pts[i].x + pts[j].x) / 2
            const ey = (pts[i].y + pts[j].y) / 2
            const md = Math.sqrt((ex - mx) ** 2 + (ey - my) ** 2)
            const hover = md < REVEAL_R ? (1 - md / REVEAL_R) ** 2 : 0
            const a = (1 - d / edgeDist) * (0.18 + hover * 0.72)
            ctx.beginPath()
            ctx.moveTo(pts[i].x, pts[i].y)
            ctx.lineTo(pts[j].x, pts[j].y)
            ctx.strokeStyle = "rgba(200,200,200," + a + ")"
            ctx.lineWidth = 0.7
            ctx.stroke()
          }
        }
      }

      for (const n of pts) {
        const md = Math.sqrt((n.x - mx) ** 2 + (n.y - my) ** 2)
        const hover = md < REVEAL_R ? (1 - md / REVEAL_R) ** 2 : 0
        const a = 0.3 + hover * 0.7
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r + hover * 1.5, 0, Math.PI * 2)
        ctx.fillStyle = "rgba(220,220,220," + a + ")"
        ctx.fill()
      }

      raf.current = requestAnimationFrame(frame)
    }

    resize()
    seed()
    raf.current = requestAnimationFrame(frame)

    const onMove = (e) => { mouse.current = { x: e.clientX, y: e.clientY } }
    const onLeave = () => { mouse.current = { x: -9999, y: -9999 } }
    const onResize = () => { resize(); seed() }

    window.addEventListener("mousemove", onMove)
    document.addEventListener("mouseleave", onLeave)
    window.addEventListener("resize", onResize)
    return () => {
      cancelAnimationFrame(raf.current)
      window.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseleave", onLeave)
      window.removeEventListener("resize", onResize)
    }
  }, [])

  return <canvas ref={canvasRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
}

export default function IndexPage() {
  return (
    <main style={{ margin: 0, padding: 0, fontFamily: "'DM Sans', sans-serif", color: "#e5e5e5" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        html { scroll-behavior: smooth; background: #0a0a0a; }

        body { overflow-x: hidden; }

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
          background: rgba(10, 10, 10, 0.9);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          transition: all 0.3s;
        }

        .navbar.on-hero {
          background: rgba(10, 10, 10, 0.9);
        }

        .nav-brand {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-family: 'DM Sans', sans-serif;
          font-size: 1.4rem;
          font-weight: 600;
          color: #e5e5e5;
          text-decoration: none;
          letter-spacing: 0.02em;
        }

        .nav-logo {
          height: 28px;
          width: auto;
        }

        .navbar.on-hero .nav-brand { color: #e5e5e5; }

        .nav-links {
          display: flex;
          align-items: center;
          gap: 2.25rem;
          list-style: none;
        }

        .nav-links a {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.05rem;
          font-weight: 500;
          color: #888;
          text-decoration: none;
          transition: color 0.2s;
        }

        .nav-links a:hover { color: #fff; }

        .navbar.on-hero .nav-links a { color: #888; }
        .navbar.on-hero .nav-links a:hover { color: #fff; }

        .nav-github {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.45rem 1rem;
          background: #fff;
          color: #111 !important;
          border-radius: 6px;
          font-size: 0.95rem;
          font-weight: 600;
          transition: all 0.2s;
        }

        .nav-github:hover {
          background: #ddd;
          transform: translateY(-1px);
        }

        .navbar.on-hero .nav-github {
          background: #fff;
          color: #111 !important;
        }

        .navbar.on-hero .nav-github:hover {
          background: #ddd;
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
          position: relative;
          overflow: hidden;
        }

        .hero-content { position: relative; z-index: 1; max-width: 780px; }

        .hero-eyebrow {
          display: inline-block;
          font-family: 'DM Sans', sans-serif;
          font-size: 0.95rem;
          font-weight: 500;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: #999;
          margin-bottom: 2.5rem;
        }

        .hero h1 {
          font-family: 'DM Sans', sans-serif;
          font-size: clamp(3.2rem, 8vw, 5.5rem);
          font-weight: 300;
          line-height: 1.1;
          color: #e5e5e5;
          margin-bottom: 1.75rem;
          letter-spacing: -0.01em;
        }

        .hero h1 em {
          font-style: italic;
          font-weight: 400;
        }

        .hero-sub {
          font-family: 'DM Sans', sans-serif;
          font-size: clamp(1.15rem, 2.5vw, 1.4rem);
          color: #999;
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
          background: #fff;
          color: #111;
          font-family: 'DM Sans', sans-serif;
          font-size: 1.05rem;
          font-weight: 600;
          border-radius: 6px;
          text-decoration: none;
          transition: all 0.2s;
        }

        .btn-primary:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(255,255,255,0.06);
          background: #ddd;
        }

        .btn-secondary {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.8rem 1.75rem;
          background: transparent;
          color: #aaa;
          font-family: 'DM Sans', sans-serif;
          font-size: 1.05rem;
          font-weight: 500;
          border-radius: 6px;
          text-decoration: none;
          border: 1px solid #444;
          transition: all 0.2s;
        }

        .btn-secondary:hover {
          color: #fff;
          border-color: #fff;
        }

        /* Brain section */
        .brain-section {
        }

        .brain-inner {
          display: flex;
          align-items: center;
          max-width: 1060px;
          margin: 0 auto;
          padding: 5rem 2rem;
          gap: 3rem;
        }

        .brain-left {
          flex: 1;
        }

        .brain-right {
          flex: 1;
          position: relative;
          min-height: 450px;
        }

        .brain-text {
          font-family: 'DM Sans', sans-serif;
          font-size: clamp(1.25rem, 2.5vw, 1.5rem);
          color: #999;
          line-height: 1.85;
          font-weight: 400;
        }

        @media (max-width: 768px) {
          .brain-inner { flex-direction: column; }
          .brain-right { width: 100%; min-height: 350px; }
        }

        /* Sections */
        .section {
          padding: 7rem 2rem;
          max-width: 1060px;
          margin: 0 auto;
        }

        .section-label {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.85rem;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #999;
          margin-bottom: 0.75rem;
        }

        .section h2 {
          font-family: 'DM Sans', sans-serif;
          font-size: clamp(2.2rem, 4.5vw, 3rem);
          font-weight: 400;
          letter-spacing: -0.01em;
          line-height: 1.2;
          margin-bottom: 1rem;
          color: #e5e5e5;
        }

        .section-subtitle {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.15rem;
          color: #999;
          line-height: 1.75;
          max-width: 520px;
          margin-bottom: 3.5rem;
          font-weight: 400;
        }

        /* Capabilities */
        .cap-row {
          display: flex;
          align-items: flex-start;
          gap: 3rem;
          padding: 3.5rem 0;
          border-bottom: 1px solid #1a1a1a;
        }

        .cap-row:last-child {
          border-bottom: none;
        }

        .cap-row-reverse {
          flex-direction: row-reverse;
        }

        .cap-text {
          flex: 1;
          min-width: 0;
        }

        .cap-diagram {
          flex: 1;
          min-width: 0;
        }

        .cap-header {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          margin-bottom: 0.75rem;
        }

        .cap-icon {
          color: #999;
          flex-shrink: 0;
        }

        .cap-title {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.35rem;
          font-weight: 600;
          color: #e5e5e5;
        }

        .cap-badge {
          display: inline-block;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          font-weight: 500;
          padding: 0.15rem 0.55rem;
          color: #66bb6a;
          background: #1b3a1b;
          border-radius: 3px;
          letter-spacing: 0.02em;
          margin-left: 0.5rem;
          vertical-align: middle;
        }

        .cap-desc {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.02rem;
          color: #999;
          line-height: 1.7;
          margin-bottom: 1rem;
        }

        .cap-research {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.95rem;
          color: #bbb;
          line-height: 1.75;
          border-left: 2px solid #66bb6a;
          padding-left: 1rem;
          margin-bottom: 1rem;
        }

        .cap-papers {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem;
        }

        .cap-paper-tag {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.82rem;
          color: #999;
          padding: 0.25rem 0.6rem;
          border: 1px solid #2a2a2a;
          border-radius: 3px;
          transition: all 0.2s;
        }

        .cap-paper-tag:hover {
          border-color: #666;
        }

        .research-link {
          color: #aaa;
          text-decoration: none;
          transition: color 0.2s;
        }

        .research-link:hover {
          color: #fff;
        }

        .research-cite {
          color: #999;
        }

        .cap-diagram-card {
        }

        .cap-diagram-card svg {
          display: block;
          width: 100%;
          height: auto;
        }

        /* Channels section */
        .channels-section {
          border-top: 1px solid #222;
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
          font-family: 'DM Sans', sans-serif;
          font-size: 1rem;
          font-weight: 500;
          color: #ccc;
          border: 1px solid #444;
          border-radius: 4px;
          transition: all 0.2s;
        }

        .channel-tag:hover {
          border-color: #fff;
        }

        /* Providers */
        .providers-section {
          padding: 7rem 2rem;
          color: #e5e5e5;
          border-top: 1px solid #222;
        }

        .providers-inner {
          max-width: 1060px;
          margin: 0 auto;
        }

        .providers-section .section-label { color: #999; }
        .providers-section h2 { color: #e5e5e5; }
        .providers-section .section-subtitle { color: #999; }

        .providers-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 1px;
          background: #2a2a2a;
          border: 1px solid #2a2a2a;
        }

        .provider-card {
          padding: 1.5rem 1rem;
          background: #111;
          text-align: center;
          transition: background 0.2s;
        }

        .provider-card:hover {
          background: #1a1a1a;
        }

        .provider-name {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.05rem;
          font-weight: 600;
          color: #e5e5e5;
          margin-bottom: 0.2rem;
        }

        .provider-model {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.88rem;
          color: #999;
          margin-bottom: 0.5rem;
        }

        .provider-tier {
          display: inline-block;
          font-family: 'DM Sans', sans-serif;
          font-size: 0.78rem;
          font-weight: 600;
          padding: 0.15rem 0.5rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #aaa;
          border: 1px solid #444;
        }

        /* Quickstart */
        .quickstart {
          padding: 7rem 2rem;
          border-top: 1px solid #222;
        }

        .quickstart-inner {
          max-width: 1060px;
          margin: 0 auto;
        }

        .code-block {
          background: #111;
          border: 1px solid #2a2a2a;
          border-radius: 4px;
          padding: 2rem;
          overflow-x: auto;
          margin-top: 2rem;
        }

        .code-block code {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.88rem;
          line-height: 1.8;
          color: #ccc;
        }

        .code-comment { color: #666; }
        .code-cmd { color: #e5e5e5; font-weight: 500; }
        .code-flag { color: #888; }

        /* CTA */
        .cta {
          padding: 8rem 2rem;
          text-align: center;
          border-top: 1px solid #222;
        }

        .cta h2 {
          font-family: 'DM Sans', sans-serif;
          font-size: clamp(2.2rem, 5vw, 3.5rem);
          font-weight: 300;
          color: #e5e5e5;
          margin-bottom: 1rem;
          letter-spacing: -0.01em;
        }

        .cta p {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.15rem;
          color: #999;
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
          border-top: 1px solid #222;
        }

        footer p {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.95rem;
          color: #999;
        }

        footer a {
          color: #888;
          text-decoration: none;
        }

        footer a:hover { color: #fff; }


        /* Benchmarks */
        .benchmarks-section {
          padding: 7rem 2rem;
          border-top: 1px solid #222;
        }

        .benchmarks-inner {
          max-width: 1060px;
          margin: 0 auto;
        }

        .benchmarks-intro {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.05rem;
          color: #ccc;
          line-height: 1.8;
          max-width: 700px;
          margin-bottom: 3rem;
        }

        .benchmarks-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1px;
          background: #2a2a2a;
          border: 1px solid #2a2a2a;
          margin-bottom: 3rem;
        }

        .bench-stat {
          padding: 2rem 1.5rem;
          background: #111;
          text-align: center;
        }

        .bench-stat-value {
          font-family: 'DM Sans', sans-serif;
          font-size: 2.5rem;
          font-weight: 300;
          color: #e5e5e5;
          line-height: 1;
          margin-bottom: 0.5rem;
        }

        .bench-stat-label {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.95rem;
          font-weight: 600;
          color: #e5e5e5;
          margin-bottom: 0.25rem;
        }

        .bench-stat-detail {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.85rem;
          color: #999;
        }

        .bench-table-label {
          font-family: 'DM Sans', sans-serif;
          font-size: 1.15rem;
          font-weight: 600;
          color: #e5e5e5;
          margin-bottom: 1rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .bench-note {
          font-family: 'DM Sans', sans-serif;
          font-size: 1rem;
          color: #999;
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
          font-family: 'DM Sans', sans-serif;
          font-size: 1.2rem;
          font-weight: 600;
          color: #e5e5e5;
          margin-bottom: 0.15rem;
        }

        .bench-metric-desc {
          font-family: 'DM Sans', sans-serif;
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
          font-family: 'DM Sans', sans-serif;
          font-size: 0.9rem;
          color: #aaa;
          text-align: right;
        }

        .bench-bar-highlight .bench-bar-name {
          color: #fff;
          font-weight: 600;
        }

        .bench-bar-track {
          height: 16px;
          background: #1a1a1a;
          border-radius: 8px;
          overflow: hidden;
        }

        .bench-bar-fill {
          height: 100%;
          background: #444;
          border-radius: 8px;
          transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .bench-bar-highlight .bench-bar-fill {
          background: #fff;
        }

        .bench-bar-val {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.85rem;
          color: #aaa;
          text-align: right;
          min-width: 2.5rem;
        }

        .bench-bar-highlight .bench-bar-val {
          color: #fff;
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
          color: #66bb6a;
          background: #1b3a1b;
          border-radius: 3px;
          letter-spacing: -0.01em;
        }

        /* Mobile */
        @media (max-width: 768px) {
          .nav-links a:not(.nav-github) { display: none; }
          .navbar { padding: 0.75rem 1.5rem; }
          .cap-row, .cap-row-reverse { flex-direction: column-reverse; }
          .cap-diagram { order: -1; }
          .benchmarks-stats { grid-template-columns: 1fr; }
          .bench-bar-row { grid-template-columns: 5.5rem 1fr auto; gap: 0.5rem; }
          .bench-bar-name { font-size: 0.8rem; }
          .bench-vs { margin-left: 6rem; }
        }
      `}</style>

      {/* Navbar */}
      <nav className="navbar on-hero" id="navbar">
        <a href="#" className="nav-brand">
          <img src={logo} alt="ScallopBot" className="nav-logo" />
          ScallopBot
        </a>
        <div className="nav-links">
          <a href="#capabilities">Features</a>
          <a href="#channels">Channels</a>
          <a href="#providers">Providers</a>
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
            <a href="#capabilities" className="btn-secondary">
              Explore features
            </a>
          </div>
        </div>
      </section>

      {/* Brain */}
      <section className="brain-section">
        <div className="brain-inner">
          <div className="brain-left">
            <p className="brain-text">
              An AI that remembers, reflects, and evolves.
              Neural pathways that strengthen with every conversation.
            </p>
          </div>
          <div className="brain-right">
            <NeuralMesh />
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section id="capabilities" className="section">
        <div className="section-label">Capabilities</div>
        <h2>Everything you need, nothing you don't</h2>
        <p className="section-subtitle">
          A complete AI assistant framework built on simplicity, privacy, and cost control.
        </p>
        {capabilities.map((cap, i) => {
          const Icon = cap.icon
          const isReverse = i % 2 === 1
          return (
            <div key={cap.title} className={`cap-row${isReverse ? " cap-row-reverse" : ""}`}>
              <div className="cap-text">
                <div className="cap-header">
                  <span className="cap-icon"><Icon size={20} strokeWidth={1.25} /></span>
                  <span className="cap-title">{cap.title}</span>
                  {cap.research && <span className="cap-badge">Research-backed</span>}
                </div>
                <p className="cap-desc">{cap.desc}</p>
                {cap.research && (
                  <p className="cap-research">{cap.research}</p>
                )}
                {cap.papers && (
                  <div className="cap-papers">
                    {cap.papers.map((p) => (
                      <span key={p.cite} className="cap-paper-tag">
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
                )}
              </div>
              <div className="cap-diagram">
                <div className="cap-diagram-card">
                  {DIAGRAMS[i]}
                </div>
              </div>
            </div>
          )
        })}
      </section>

      {/* Channels */}
      <section id="channels" className="channels-section">
        <div className="channels-inner">
          <div className="section-label">Channels</div>
          <h2>One process, every platform</h2>
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
            <p className="section-subtitle">
            Every request routes to the cheapest capable model. When a provider goes down, traffic shifts instantly.
          </p>
          <div className="providers-grid">
            {providers.map((p) => (
              <div key={p.name} className="provider-card">
                <div className="provider-name">{p.name}</div>
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

      {/* Benchmarks */}
      <section id="benchmarks" className="benchmarks-section">
        <div className="benchmarks-inner">
          <div className="section-label">Benchmarks</div>
          <h2>30-day cognitive pipeline evaluation</h2>
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
          ScallopBot &mdash; MIT License &mdash; <a href={GITHUB_URL}>GitHub</a> &mdash; <a href="https://x.com/tashfene" target="_blank" rel="noopener noreferrer">@tashfene</a>
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
