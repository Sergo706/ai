<script setup lang="ts">
const capabilities = landingCapabilities;
</script>

<template>
  <section class="mx-auto w-full max-w-304 px-6 py-22">
    <header class="max-w-160">
      <p class="text-xs font-medium tracking-[0.14em] text-ink-dim uppercase">
        Capabilities
      </p>
      <h2
        class="mt-3.5 text-[clamp(1.65rem,3vw,2.25rem)] font-medium leading-[1.15] tracking-tight text-balance text-ink"
      >
        Everything the runtime needs.
      </h2>
      <p
        class="mt-4 text-[0.9375rem] leading-[1.75] text-pretty text-ink-muted"
      >
        Every layer you would otherwise stitch together yourself, behind one API
        that stays out of the way.
      </p>
    </header>

    <ul
      class="mt-12 grid grid-cols-1 border-t border-l border-line sm:grid-cols-2 lg:grid-cols-3"
    >
      <li
        v-for="item in capabilities"
        :key="item.title"
        class="border-r border-b border-line px-7 pt-[1.9rem] pb-[2.1rem] transition-colors hover:bg-white/[0.022]"
      >
        <UIcon :name="item.icon" class="size-[1.15rem] text-[#9a9a9a]" />
        <h3
          class="mt-4 text-[0.9375rem] font-medium tracking-[-0.01em] text-ink"
        >
          {{ item.title }}
        </h3>
        <p
          class="mt-2.5 text-[0.8375rem] leading-[1.7] text-pretty text-ink-muted"
        >
          {{ item.body }}
        </p>
      </li>
    </ul>
  </section>
</template>
