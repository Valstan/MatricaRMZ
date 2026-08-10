/**
 * Правила ответов ИИваныча (ai_chat_meta.rules_md) — чтение и замена с проды/дева.
 *
 *   corepack pnpm ai:rules get > current.md
 *   corepack pnpm ai:rules set docs/ai-chat/RULES.seed.md
 *
 * Раньше правилами владела облачная рутина через REST; после D-024 движок ходит в
 * DeepSeek напрямую, и единственный редактор правил — этот скрипт.
 */
import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { getAiChatRules, setAiChatRules } from '../services/ai/aiChatRulesService.js';

async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'get') {
    const rules = await getAiChatRules();
    process.stdout.write(rules ?? '(правила не заданы)\n');
    return;
  }
  if (cmd === 'set') {
    if (!file) throw new Error('укажите файл: ai:rules set <path.md>');
    const res = await setAiChatRules({ rulesMd: readFileSync(file, 'utf8'), changedBy: 'owner-cli' });
    console.log(`правила обновлены: ${res.bytes} байт (старая версия — в ai_chat_rules_history)`);
    return;
  }
  throw new Error('использование: ai:rules get | ai:rules set <path.md>');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
