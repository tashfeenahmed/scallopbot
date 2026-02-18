export interface CommandDefinition {
  name: string;
  description: string;
  category: 'builtin' | 'skill';
  sendImmediately: boolean;
}

export const COMMANDS: CommandDefinition[] = [
  // Built-in commands — sent immediately on select
  { name: 'new', description: 'Start a new conversation', category: 'builtin', sendImmediately: true },
  { name: 'help', description: 'Show available commands', category: 'builtin', sendImmediately: true },
  { name: 'model', description: 'Switch AI model', category: 'builtin', sendImmediately: true },
  { name: 'usage', description: 'View token usage and costs', category: 'builtin', sendImmediately: true },
  { name: 'stop', description: 'Stop current generation', category: 'builtin', sendImmediately: true },
  { name: 'verbose', description: 'Toggle debug output', category: 'builtin', sendImmediately: true },
  { name: 'settings', description: 'View configuration', category: 'builtin', sendImmediately: true },

  // Skill commands — inserted into input with trailing space
  { name: 'memory_search', description: 'Search long-term memory', category: 'skill', sendImmediately: false },
  { name: 'goals', description: 'Manage goals, milestones, and tasks', category: 'skill', sendImmediately: false },
  { name: 'board', description: 'View and manage the task board', category: 'skill', sendImmediately: false },
];
