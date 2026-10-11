/**
 * Host half of the latest-Turn live statistics bundle.
 *
 * The features in `@deepseek-ai/dsh-client-ui-chat` already fold whole-session
 * totals from a Host projection; this bundle answers the narrower question with
 * data the browser already has, so the Host registers nothing.
 *
 * `./client` registers one pill in `conversation.composer.dock` beside the
 * shipped session-stats pill and folds the current Session's event window into
 * the newest Turn's first-token latency and decode throughput.
 */
export function apply() {}
