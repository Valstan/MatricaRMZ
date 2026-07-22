#!/usr/bin/env node
// SessionStart hook: имя сессии "<Проект> <день> <месяц>", напр. "Матрица РМЗ 22 июля".
// Рецепт — brain pool #081 (set_session_title недоступен для текущей сессии, только hook).
const PROJECT = 'Матрица РМЗ';
const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `${PROJECT} ${date}` },
}));
