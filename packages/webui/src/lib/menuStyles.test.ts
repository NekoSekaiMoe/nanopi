import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

test('/ and @ menus share command menu selection colors', () => {
  const css = readFileSync(join(root, 'src/styles/app.css'), 'utf8');
  const theme = readFileSync(join(root, 'src/styles/theme.css'), 'utf8');

  assert.match(theme, /--app-command-menu-hover-background:/);
  assert.match(theme, /--app-command-menu-active-background:/);
  assert.match(theme, /--app-command-menu-active-background:color-mix\(in srgb,var\(--app-brand\)/);
  assert.match(theme, /--app-command-menu-active-accent:/);
  assert.match(css, /\.slash-row\.active\s*\{\s*background:\s*var\(--app-command-menu-active-background\)/);
  assert.match(css, /\.at-row\.active\s*\{\s*background:\s*var\(--app-command-menu-active-background\)/);
  assert.match(css, /\.slash-row\.active\s*\{[^}]*--app-command-menu-active-accent/s);
  assert.match(css, /\.at-row\.active\s*\{[^}]*--app-command-menu-active-accent/s);
  assert.match(css, /\.slash-row:hover\s*\{\s*background:\s*var\(--app-command-menu-hover-background\)/);
  assert.match(css, /\.at-row:hover\s*\{\s*background:\s*var\(--app-command-menu-hover-background\)/);
});

test('run modes use canonical order (standard, plan, minimal)', () => {
  const selector = readFileSync(join(root, 'src/components/ModeSelector.tsx'), 'utf8');
  const messages = readFileSync(join(root, 'src/i18n.ts'), 'utf8');
  const standard = selector.indexOf("val: 'standard'");
  const plan = selector.indexOf("val: 'plan'");
  const minimal = selector.indexOf("val: 'minimal'");

  assert.ok(standard >= 0);
  assert.ok(standard < plan);
  assert.ok(plan < minimal);
  assert.match(messages, /'mode\.standard':\s*'Standard'/);
  assert.doesNotMatch(messages, /'mode\.build':/);
  assert.doesNotMatch(messages, /'mode\.auto':/);
});
