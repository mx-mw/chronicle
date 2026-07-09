/**
 * Answering questions over the knowledge base.
 *
 * Retrieval finds the facts; the model only writes them up. Every claim in the
 * answer must cite the note it came from, so a wrong answer is traceable back
 * to a wrong note rather than to an invisible hallucination.
 */
import { completeText } from './llm.js';
import { search, type Hit } from './store.js';

const SYSTEM_PROMPT = `You answer questions using ONLY the excerpts from a team's knowledge base given below.

Rules:
- Ground every claim in the excerpts. If they don't answer the question, say so plainly — do not guess or fill gaps from general knowledge.
- Cite the source note after each claim, in square brackets: [topics/storage].
- Synthesise across excerpts rather than listing them. If two excerpts disagree, say that they disagree.
- Be brief. Two or three sentences is usually enough. No preamble.`;

export interface RecallResult {
  answer: string;
  hits: Hit[];
}

function renderExcerpts(hits: Hit[]): string {
  return hits
    .map((hit) => `[${hit.file.replace(/\.md$/, '')}] (${hit.noteTitle})\n${hit.text}`)
    .join('\n\n');
}

/**
 * Retrieve, then synthesise. Returns the hits alongside the answer so callers
 * can show their work — the answer is only as trustworthy as what fed it.
 */
export async function recall(question: string, limit = 8): Promise<RecallResult> {
  const hits = await search(question, limit);
  if (hits.length === 0) {
    return { answer: `Nothing in the knowledge base is relevant to "${question}".`, hits };
  }

  const answer = await completeText({
    system: SYSTEM_PROMPT,
    user: `Question: ${question}\n\nExcerpts from the knowledge base:\n\n${renderExcerpts(hits)}`,
    maxTokens: 1_000,
  });

  return { answer, hits };
}
