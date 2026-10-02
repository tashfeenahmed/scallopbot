/**
 * Personal-assistant tasks: multi-step file work a personal bot does all day.
 * Scored from the files the agent wrote, plus the reply where the user asked
 * a question.
 */

import type { BenchTask } from '../types.js';
import { checks, fail, mentionsNumber, readText, visibleText, writeFiles } from './util.js';

const NOTES_MD = `# Launch sync — 2026-09-22

Attendees: Priya, Tom, Aisha

- Priya will own the launch end to end.
- We agreed the public launch date is 14 October 2026.
- Budget approved: £12,500 (ads + influencer kit).
- Tom asked about the Android build; it is not blocking.

## Action items
- Tom: finish the press kit by Oct 3
- Aisha: book the launch-day livestream
- Priya: confirm the influencer shortlist

Random: the office coffee machine is broken again.
`;

const notesSummary: BenchTask = {
  id: 'assistant-notes-summary',
  category: 'assistant',
  title: 'read notes.md, write summary.md with specific facts',
  prompt: [
    'Read notes.md and write summary.md with: the launch date, the budget, who owns the launch, and the action items as a bullet list.',
  ],
  setup: ws => writeFiles(ws, { 'notes.md': NOTES_MD }),
  async score(ws) {
    const summary = await readText(ws, 'summary.md');
    if (summary === null) return fail('summary.md missing');
    const bullets = summary.split('\n').filter(line => /^\s*(?:[-*•]|\d+\.)\s+\S/.test(line)).length;
    return checks([
      ['launch date', /14(?:th)? oct|oct(?:ober)? 14|2026-10-14/i.test(summary)],
      ['budget', /12,?500/.test(summary)],
      ['owner Priya', /priya/i.test(summary)],
      ['press kit item', /press kit/i.test(summary)],
      ['livestream item', /livestream/i.test(summary)],
      ['influencer shortlist item', /shortlist/i.test(summary)],
      [`bullet list (${bullets} bullets)`, bullets >= 3],
      ['no coffee-machine noise', !/coffee/i.test(summary)],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'read_file', input: { path: 'notes.md' } }],
      [{
        name: 'write_file',
        input: {
          path: 'summary.md',
          content: '# Launch summary\n\n- Launch date: 14 October 2026\n- Budget: £12,500\n- Owner: Priya\n\n## Action items\n- Tom: finish the press kit by Oct 3\n- Aisha: book the launch-day livestream\n- Priya: confirm the influencer shortlist\n',
        },
      }],
    ],
    reply: 'Wrote summary.md: launch 14 October 2026, budget £12,500, owned by Priya, plus the three action items.',
  }],
};

const HOME_TODO = `[ ] Call the plumber
[x] Renew car insurance
[ ] Buy birthday present for Sam
[ ] Book dentist
`;
const WORK_TODO = `[ ] Review Q4 roadmap
[x] Send invoice to Acme
[ ] Answer Lena about the API
[ ] Clean up staging bucket
`;

const todoMerge: BenchTask = {
  id: 'assistant-todo-merge',
  category: 'assistant',
  title: 'merge two todo lists, drop done items, sort',
  prompt: [
    'Merge todo-home.txt and todo-work.txt into todo.md with two sections, "## Home" and "## Work". Leave out anything already marked [x], and sort the items alphabetically within each section.',
  ],
  setup: ws => writeFiles(ws, { 'todo-home.txt': HOME_TODO, 'todo-work.txt': WORK_TODO }),
  async score(ws) {
    const todo = await readText(ws, 'todo.md');
    if (todo === null) return fail('todo.md missing');
    const section = (name: string) => {
      const match = new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i').exec(todo);
      return (match?.[1] ?? '')
        .split('\n')
        .map(line => line.replace(/^\s*(?:[-*]\s*)?(?:\[ \]\s*)?/, '').trim())
        .filter(Boolean);
    };
    const home = section('Home');
    const work = section('Work');
    const sorted = (items: string[]) => items.every((item, i) => i === 0 || items[i - 1]!.localeCompare(item) <= 0);
    return checks([
      ['home items', home.length === 3 && ['plumber', 'present', 'dentist'].every(k => home.some(i => i.toLowerCase().includes(k)))],
      ['work items', work.length === 3 && ['roadmap', 'lena', 'staging'].every(k => work.some(i => i.toLowerCase().includes(k)))],
      ['done items dropped', !/insurance|invoice/i.test(todo)],
      ['sorted', sorted(home) && sorted(work)],
    ]);
  },
  reference: [{
    steps: [
      [
        { name: 'read_file', input: { path: 'todo-home.txt' } },
        { name: 'read_file', input: { path: 'todo-work.txt' } },
      ],
      [{
        name: 'write_file',
        input: {
          path: 'todo.md',
          content: '## Home\n- [ ] Book dentist\n- [ ] Buy birthday present for Sam\n- [ ] Call the plumber\n\n## Work\n- [ ] Answer Lena about the API\n- [ ] Clean up staging bucket\n- [ ] Review Q4 roadmap\n',
        },
      }],
    ],
    reply: 'Merged into todo.md: 3 home and 3 work items, done ones dropped, sorted.',
  }],
};

const EXPECTED_EXPENSES = [
  'date,category,amount',
  '2026-09-01,food,12.40',
  '2026-09-02,transport,3.10',
  '2026-09-02,food,8.75',
  '2026-09-03,books,22.00',
];

const expenses: BenchTask = {
  id: 'assistant-expenses-multiturn',
  category: 'assistant',
  title: 'log expenses, then answer a question and append (two turns)',
  prompt: [
    'Start an expenses.csv for me with the header date,category,amount and add these: 2026-09-01 food 12.40; 2026-09-02 transport 3.10; 2026-09-02 food 8.75.',
    'How much have I spent on food in total? Also add 2026-09-03 books 22.00 to the file.',
  ],
  setup: () => undefined,
  async score(ws, trace) {
    const csv = await readText(ws, 'expenses.csv');
    if (csv === null) return fail('expenses.csv missing');
    const rows = csv.trim().split('\n').map(line => line.trim().replace(/\s*,\s*/g, ','));
    const normalizeAmount = (row: string) => row.replace(/,(\d+(?:\.\d+)?)$/, (_, n: string) => `,${Number(n).toFixed(2)}`);
    const secondReply = trace.turns[1]?.response ?? '';
    return checks([
      ['csv rows exact', rows.length === EXPECTED_EXPENSES.length && rows.every((row, i) => normalizeAmount(row) === EXPECTED_EXPENSES[i])],
      ['food total 21.15 in turn-2 reply', mentionsNumber(`${secondReply}\n${visibleText(trace)}`, 21.15)],
    ]);
  },
  reference: [
    {
      steps: [[{
        name: 'write_file',
        input: { path: 'expenses.csv', content: `${EXPECTED_EXPENSES.slice(0, 4).join('\n')}\n` },
      }]],
      reply: 'Created expenses.csv with the three expenses.',
    },
    {
      steps: [[{ name: 'write_file', input: { path: 'expenses.csv', content: `${EXPECTED_EXPENSES[4]}\n`, append: true } }]],
      reply: 'Food so far: 21.15 (12.40 + 8.75). Added the 22.00 books expense.',
    },
  ],
};

export const ASSISTANT_TASKS: BenchTask[] = [notesSummary, todoMerge, expenses];
