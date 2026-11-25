<template>
  <section class="mx-auto w-full max-w-304 px-6 py-22">
    <div
      class="grid grid-cols-[minmax(0,1fr)] items-start gap-14 *:min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center lg:gap-18"
    >
      <div class="lg:order-2">
        <p class="text-xs font-medium tracking-[0.14em] text-ink-dim uppercase">
          Tools
        </p>
        <h2
          class="mt-3.5 text-[clamp(1.65rem,3vw,2.25rem)] font-medium leading-[1.15] tracking-tight text-balance text-ink"
        >
          Typed tools, bound per turn.
        </h2>
        <p class="mt-4 text-[0.9375rem] leading-[1.75] text-pretty text-ink-muted">
          A spec describes the tool once and builds a fresh handler per turn.
          That is what lets a handler capture the user, the conversation, or a
          connection that only exists for that request.
        </p>
        <p class="mt-4 text-[0.9375rem] leading-[1.75] text-pretty text-ink-muted">
          The type argument names your own metadata. Supply it on the agent, then
          override any field per turn, because a turn's
          <code class="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[0.85em] text-ink">meta</code>
          is spread over the agent's before the factories run.
        </p>
      </div>

      <LandingCodeWindow filename="tools.ts" class="lg:order-1">
<pre class="m-0 overflow-x-auto px-[1.15rem] pt-[1.1rem] pb-[1.35rem] font-mono text-[0.7825rem] leading-[1.75] text-[#c9c9c9] tab-2"><code><span class="text-code-key">import type</span> { ToolSpec } <span class="text-code-key">from</span> <span class="text-code-str">"@riavzon/ai"</span>;

<span class="text-code-key">type</span> <span class="text-code-const">RequestMeta</span> = {
  tenantId: <span class="text-code-key">string</span>;
  timezone: <span class="text-code-key">string</span>;
};

<span class="text-code-key">const</span> weather: <span class="text-code-const">ToolSpec</span>&lt;<span class="text-code-const">RequestMeta</span>&gt; = {
  name: <span class="text-code-str">"get_weather"</span>,
  definitions: {
    type: <span class="text-code-str">"function"</span>,
    function: {
      name: <span class="text-code-str">"get_weather"</span>,
      description: <span class="text-code-str">"Weather for a city"</span>,
      parameters: {
        type: <span class="text-code-str">"object"</span>,
        properties: { city: { type: <span class="text-code-str">"string"</span> } },
      },
    },
  },
  <span class="text-code-comment">// ctx.meta is your type, merged from config and turn</span>
  make: (ctx) =&gt; <span class="text-code-key">async</span> ({ city }) =&gt;
    <span class="text-code-fn">fetchWeather</span>(<span class="text-code-fn">String</span>(city), ctx.meta?.timezone),
  cache: { ttl: <span class="text-code-num">600</span> },
};</code></pre>
      </LandingCodeWindow>
    </div>
  </section>
</template>
