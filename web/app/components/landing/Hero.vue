<script setup lang="ts">
const installCommand = landingInstallCommand
const repoUrl = landingRepoUrl

const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(installCommand)
    copied.value = true
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => (copied.value = false), 1600)
  } catch {
    copied.value = false
  }
}

onBeforeUnmount(() => clearTimeout(resetTimer))
</script>

<template>
  <section class="relative isolate pt-28 pb-24">
    <div
      class="pointer-events-none absolute -top-[20%] left-1/2 -z-10 h-[34rem] w-[min(60rem,130%)] -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgb(255_255_255/0.09),rgb(255_255_255/0.02)_40%,transparent_70%)] blur-[20px]"
      aria-hidden="true"
    />
    <div
      class="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgb(255_255_255/0.045)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.045)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,black,transparent_78%)]"
      aria-hidden="true"
    />

    <div class="relative mx-auto w-full max-w-[76rem] px-6">
      <span
        class="inline-flex items-center gap-2 rounded-full border border-line bg-white/[0.03] py-[0.3rem] pr-[0.7rem] pl-[0.55rem] text-[0.78rem] text-ink-muted"
      >
        <span
          class="size-1.5 rounded-full bg-[#4ade80] shadow-[0_0_8px_rgb(74_222_128/0.55)]"
        />
        <code class="font-sans tracking-[-0.01em] text-ink">@riavzon/ai</code>
      </span>

      <h1
        class="mt-7 flex flex-col text-[clamp(2.75rem,7vw,4.75rem)] font-medium leading-[1.02] tracking-[-0.035em]"
      >
        <span
          class="bg-[linear-gradient(to_bottom,#ffffff_20%,#8f8f8f_130%)] bg-clip-text text-transparent"
        >
          Agents as a library.
        </span>
        <span class="font-serif text-[#6f6f6f] font-normal italic tracking-[-0.02em]">
          Not a framework.
        </span>
      </h1>

      <p
        class="mt-7 max-w-[38rem] text-[1.0625rem] leading-[1.65] text-pretty text-ink-muted"
      >
        An embeddable TypeScript agent runtime. It runs the agent loop, the tool
        protocol, retrieval, and the durable run lifecycle, then hands control
        back. No framework underneath, no port opened, no prompt hidden.
      </p>

      <div class="mt-9 flex flex-wrap gap-3">
        <UButton
          to="/getting-started/introduction"
          size="lg"
          trailing-icon="i-lucide-arrow-right"
          class="border-white bg-white font-medium text-[#0a0a0a] hover:border-[#e6e6e6] hover:bg-[#e6e6e6]"
        >
          Get started
        </UButton>

        <UButton
          :to="repoUrl"
          target="_blank"
          size="lg"
          color="neutral"
          variant="outline"
          icon="i-simple-icons-github"
        >
          Source
        </UButton>
      </div>

      <button
        type="button"
        class="mt-8 inline-flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-raised py-[0.55rem] pr-2.5 pl-[0.85rem] text-[0.8125rem] text-ink-muted transition-colors hover:border-[#333] hover:text-ink"
        :aria-label="`Copy ${installCommand}`"
        @click="copyInstall"
      >
        <UIcon name="i-lucide-terminal" class="size-[0.9375rem] text-ink-dim" />
        <code class="font-mono tracking-[-0.01em] text-ink">
          {{ installCommand }}
        </code>
        <span
          class="ml-2 inline-flex items-center gap-1.5 border-l border-line py-[0.2rem] pr-2 pl-2 text-xs text-ink-dim"
        >
          <UIcon
            :name="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            class="size-3.5"
          />
          {{ copied ? 'Copied' : 'Copy' }}
        </span>
      </button>
    </div>
  </section>
</template>
