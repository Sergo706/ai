export default defineAppConfig({
  docus: {
    colorMode: 'dark',
  },
  header: {
    title: 'Riavzon AI',
    logo: {
      light: '/favicon.svg',
      dark: '/favicon.svg',
      alt: 'Riavzon AI',
      favicon: '/favicon.ico',
    },
  },

  github: {
    url: 'https://github.com/Sergo706/ai',
    branch: 'main',
    rootDir: 'web',
  },

  socials: {
    site: 'https://riavzon.com',
  },

  toc: {
    bottom: {
      title: 'Elsewhere',
      links: [
        {
          icon: 'i-lucide-globe',
          label: 'riavzon.com',
          to: 'https://riavzon.com',
          target: '_blank',
        },
        {
          icon: 'i-simple-icons-github',
          label: 'Source',
          to: 'https://github.com/Sergo706/ai',
          target: '_blank',
        },
        {
          icon: 'i-lucide-pen-line',
          label: 'Writing',
          to: 'https://riavzon.com/writing',
          target: '_blank',
        },
      ],
    },
  },

  ui: {
    colors: {
      primary: 'emerald',
      neutral: 'neutral',
    },

    contentNavigation: {
      defaultVariants: {
        highlight: true,
        color: 'neutral',
        highlightColor: 'neutral',
      },
    },
    contentToc: {
      defaultVariants: {
        highlight: true,
        color: 'neutral',
        highlightColor: 'neutral',
      },
    },
    pageHero: {
      slots: {
        description: 'text-muted text-balance',
      },
    },
    prose: {
      h1: { slots: { base: 'font-serif italic text-highlighted' } },
      h2: { slots: { base: 'font-serif italic text-highlighted' } },
      h3: { slots: { base: 'font-serif text-highlighted' } },
      h4: { slots: { base: 'font-serif text-highlighted' } },
      a: {
        base: 'font-medium transition-colors hover:text-primary/90',
      },
    },
  },
})
