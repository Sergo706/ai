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
      primary: 'neutral',
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
    pageHeader: {
      slots: {
        headline: 'text-xs font-medium tracking-[0.14em] uppercase text-muted',
      },
    },
    pageHero: {
      slots: {
        description: 'text-muted text-balance',
      },
    },
    prose: {
      h1: {
        slots: {
          base: 'font-sans not-italic font-medium leading-[1.1] tracking-tight text-highlighted [&_code]:font-medium',
        },
      },
      h2: {
        slots: {
          base: 'font-serif tracking-tight text-highlighted [&_code]:font-medium',
        },
      },
      h3: {
        slots: {
          base: 'font-serif tracking-tight text-highlighted [&_code]:font-medium',
        },
      },
      h4: {
        slots: {
          base: 'font-serif tracking-tight text-highlighted [&_code]:font-medium',
        },
      },
      a: {
        base: 'text-highlighted font-medium border-b border-primary/35 hover:border-primary hover:text-primary transition-colors',
      },
    },
  },
})
