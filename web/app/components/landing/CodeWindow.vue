<script setup lang="ts">
defineProps<{
  /** Filename shown in the window chrome. */
  filename: string
}>()
</script>

<template>
  <div
    class="overflow-hidden rounded-xl border border-line bg-[#0d0d0d] shadow-[inset_0_1px_0_0_rgb(255_255_255/0.04),0_30px_60px_-30px_rgb(0_0_0/0.9)]"
  >
    <div
      class="flex items-center gap-[0.7rem] border-b border-line bg-[#0f0f0f] px-3.5 py-2.5"
    >
      <span class="inline-flex gap-1.5" aria-hidden="true">
        <i class="size-2 rounded-full bg-[#2a2a2a]" />
        <i class="size-2 rounded-full bg-[#2a2a2a]" />
        <i class="size-2 rounded-full bg-[#2a2a2a]" />
      </span>
      <span class="font-mono text-[0.72rem] text-ink-dim">{{ filename }}</span>
    </div>

    <slot />
  </div>
</template>


