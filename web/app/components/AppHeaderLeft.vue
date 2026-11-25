<script setup lang="ts">
const appConfig = useAppConfig()
const site = useSiteConfig()
const { localePath } = useDocusI18n()

const ariaLabel = appConfig.header?.title || site.name
</script>

<template>
  <NuxtLink
    :to="localePath('/')"
    :aria-label="ariaLabel"
    class="flex items-center gap-2"
  >
    <AppHeaderLogo class="h-6 w-auto shrink-0" />
    <span
      v-if="appConfig.header?.title"
      class="truncate font-serif text-lg italic leading-none text-highlighted"
    >
      {{ appConfig.header?.title }}
    </span>
  </NuxtLink>
</template>
