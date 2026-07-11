import { useCallback, useEffect, useState } from 'react';

interface TaskResult {
  summary?: string;
  tests?: string[];
  blockers?: string[];
  changedFiles?: string[];
  artifacts?: Array<{ type: string; value: string }>;
}

interface DelegatedTask {
  id: string;
  taskName?: string | null;
  label: string;
  task: string;
  status: string;
  role?: string;
  spawnDepth?: number;
  parentRunId?: string | null;
  batchId?: string | null;
  result?: TaskResult | null;
  error?: string | null;
  createdAt: number;
  startedAt?: number | null;
  lastProgressAt?: number | null;
  completedAt?: number | null;
}

const ACTIVE = new Set(['pending', 'running']);

export default function TasksPanel() {
  const [tasks, setTasks] = useState<DelegatedTask[]>([]);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [logs, setLogs] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/subagents?limit=150', { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { tasks: DelegatedTask[] };
      setTasks(data.tasks);
      setError('');
    } catch (err) {
      setError(`Could not load delegated tasks: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const cancel = async (id: string) => {
    await fetch(`/api/subagents/${encodeURIComponent(id)}/control`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    await refresh();
  };

  const control = async (id: string, action: 'steer' | 'followup') => {
    if (!instruction.trim()) return;
    await fetch(`/api/subagents/${encodeURIComponent(id)}/control`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, message: instruction.trim() }),
    });
    setInstruction('');
    await refresh();
  };

  const loadLog = async (id: string) => {
    const response = await fetch(`/api/subagents/${encodeURIComponent(id)}/log`, { credentials: 'include' });
    const data = await response.json() as { messages?: Array<{ role: string; content: string }>; error?: string };
    setLogs(previous => ({
      ...previous,
      [id]: data.messages?.map(message => `${message.role}: ${message.content}`).join('\n\n') || data.error || 'No retained log.',
    }));
  };

  return (
    <main className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 p-5">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-end justify-between mb-5">
          <div>
            <h1 className="text-xl font-semibold">Delegated tasks</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Live status, lineage, evidence, blockers, and controls.</p>
          </div>
          <button onClick={() => void refresh()} className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-neutral-700 text-sm">Refresh</button>
        </div>
        {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
        <div className="space-y-2">
          {tasks.map(task => {
            const isExpanded = expanded === task.id;
            const active = ACTIVE.has(task.status);
            return (
              <section key={task.id} style={{ marginLeft: `${Math.min(task.spawnDepth || 0, 4) * 20}px` }} className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                <button onClick={() => setExpanded(isExpanded ? null : task.id)} className="w-full text-left p-4 flex gap-3 items-start">
                  <span className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${task.status === 'completed' ? 'bg-green-500' : task.status === 'running' ? 'bg-blue-500 animate-pulse' : task.status === 'pending' ? 'bg-yellow-400' : task.status === 'blocked' ? 'bg-orange-500' : 'bg-red-500'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <strong className="truncate">{task.taskName || task.label}</strong>
                      <span className="text-[11px] uppercase tracking-wide text-gray-500">{task.status}</span>
                      {task.role === 'orchestrator' && <span className="text-[11px] rounded bg-purple-100 dark:bg-purple-950 px-1.5 py-0.5">orchestrator</span>}
                    </span>
                    <span className="block text-sm text-gray-600 dark:text-gray-300 truncate mt-1">{task.result?.summary || task.task}</span>
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">{new Date(task.createdAt).toLocaleString()}</span>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 ml-5 text-sm space-y-3">
                    <p className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{task.task}</p>
                    {(task.result?.blockers?.length || task.error) && <div><strong>Blockers</strong><ul className="list-disc ml-5 mt-1">{task.result?.blockers?.map(item => <li key={item}>{item}</li>)}{task.error && <li>{task.error}</li>}</ul></div>}
                    {!!task.result?.tests?.length && <div><strong>Tests</strong><ul className="list-disc ml-5 mt-1">{task.result.tests.map(item => <li key={item}>{item}</li>)}</ul></div>}
                    {!!task.result?.changedFiles?.length && <div><strong>Changed files</strong><div className="font-mono text-xs mt-1">{task.result.changedFiles.join(', ')}</div></div>}
                    <div className="flex gap-2">
                      <input value={instruction} onChange={event => setInstruction(event.target.value)} placeholder={active ? 'Steer this worker…' : 'Start a follow-up…'} className="flex-1 rounded-lg border border-gray-300 dark:border-neutral-700 bg-transparent px-3 py-1.5" />
                      <button onClick={() => void control(task.id, active ? 'steer' : 'followup')} className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-neutral-700">{active ? 'Steer' : 'Follow up'}</button>
                    </div>
                    <div className="flex gap-2">
                      {active && <button onClick={() => void cancel(task.id)} className="px-3 py-1.5 rounded-lg bg-red-600 text-white">Cancel</button>}
                      <button onClick={() => void loadLog(task.id)} className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-neutral-700">Load log</button>
                      <span className="font-mono text-xs text-gray-400 self-center">{task.id}</span>
                    </div>
                    {logs[task.id] && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-100 dark:bg-black p-3 text-xs">{logs[task.id]}</pre>}
                  </div>
                )}
              </section>
            );
          })}
          {tasks.length === 0 && !error && <div className="text-center text-gray-500 py-20">No delegated tasks yet.</div>}
        </div>
      </div>
    </main>
  );
}
