<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
const principles = landingPrinciples;
</script>

<template>
  <section class="mx-auto w-full max-w-304 px-6 py-22">
    <div
      class="grid grid-cols-[minmax(0,1fr)] items-start gap-14 *:min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center lg:gap-18"
    >
      <div>
        <p class="text-xs font-medium tracking-[0.14em] text-ink-dim uppercase">
          Quickstart
        </p>
        <h2
          class="mt-3.5 text-[clamp(1.65rem,3vw,2.25rem)] font-medium leading-[1.15] tracking-tight text-balance text-ink"
        >
          Two calls and a turn.
        </h2>
        <p
          class="mt-4 text-[0.9375rem] leading-[1.75] text-pretty text-ink-muted"
        >
          Configure once at startup, then build an agent and run it. The same
          objects work in a script, a queue worker, or an HTTP handler.
        </p>

        <ul class="mt-7 grid gap-[0.7rem]">
          <li
            v-for="line in principles"
            :key="line"
            class="flex items-start gap-2.5 text-sm leading-[1.6] text-ink-muted"
          >
            <UIcon
              name="i-lucide-minus"
              class="mt-[0.3rem] size-3.5 flex-none text-ink-dim"
            />
            <span>{{ line }}</span>
          </li>
        </ul>
      </div>

      <LandingCodeWindow filename="turn.ts">
        <pre
          class="m-0 overflow-x-auto px-[1.15rem] pt-[1.1rem] pb-[1.35rem] font-mono text-[0.7825rem] leading-[1.75] text-[#c9c9c9] tab-2"
        ><code><span class="text-code-key">import</span> OpenAI <span class="text-code-key">from</span> <span class="text-code-str">"openai"</span>;
<span class="text-code-key">import</span> { configuration, createAgent } <span class="text-code-key">from</span> <span class="text-code-str">"@riavzon/ai"</span>;

<span class="text-code-key">await</span> <span class="text-code-fn">configuration</span>({
  db: <span class="text-code-str">"./data/app.db"</span>,
  openAiConfig: <span class="text-code-key">new</span> <span class="text-code-fn">OpenAI</span>({
    apiKey: process.env.<span class="text-code-const">OPENAI_API_KEY</span>,
  }),
  embeddingConfig: {
    dimensions: <span class="text-code-num">1536</span>,
    matchingModel: <span class="text-code-str">"text-embedding-3-small"</span>,
    retrievalModel: <span class="text-code-str">"text-embedding-3-small"</span>,
  },
});

<span class="text-code-key">const</span> agent = <span class="text-code-key">await</span> <span class="text-code-fn">createAgent</span>({
  model: { model: <span class="text-code-str">"gpt-4o-mini"</span> },
  systemInstructions: <span class="text-code-str">"You answer in one paragraph."</span>,
  tools: { common: [<span class="text-code-str">"get_current_datetime"</span>] },
});

<span class="text-code-key">const</span> { text } = <span class="text-code-key">await</span> agent.<span class="text-code-fn">complete</span>({
  message: <span class="text-code-str">"What time is it in Tokyo?"</span>,
  user: { timezone: <span class="text-code-str">"Asia/Tokyo"</span> },
});</code></pre>
      </LandingCodeWindow>
    </div>
  </section>
</template>
