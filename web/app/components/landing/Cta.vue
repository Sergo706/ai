<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
const repoUrl = landingRepoUrl;
</script>

<template>
  <section class="mx-auto w-full max-w-304 px-6">
    <div
      class="relative isolate mb-24 overflow-hidden rounded-2xl border border-line bg-raised px-8 py-16 text-center"
    >
      <div
        class="pointer-events-none absolute inset-x-0 bottom-[-60%] left-1/2 -z-10 h-80 w-136 -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgb(255_255_255/0.1),transparent_70%)] blur-[30px]"
        aria-hidden="true"
      />

      <h2
        class="font-serif text-[clamp(1.9rem,4vw,2.75rem)] italic leading-[1.1] tracking-[-0.02em] text-ink"
      >
        Start with one file.
      </h2>
      <p
        class="mx-auto mt-4 max-w-lg text-[0.9375rem] leading-[1.7] text-pretty text-ink-muted"
      >
        No daemon, no schema of your own, no account. Point it at a SQLite path
        and the first turn works.
      </p>

      <div class="mt-9 flex flex-wrap justify-center gap-3">
        <UButton
          to="/getting-started/introduction"
          size="lg"
          trailing-icon="i-lucide-arrow-right"
          class="border-white bg-white font-medium text-[#0a0a0a] hover:border-[#e6e6e6] hover:bg-[#e6e6e6]"
        >
          Read the guide
        </UButton>

        <UButton
          :to="repoUrl"
          target="_blank"
          size="lg"
          color="neutral"
          variant="outline"
          icon="i-simple-icons-github"
        >
          Browse the source
        </UButton>
      </div>
    </div>
  </section>
</template>
