import type { HeadConfig, TransformContext } from "vitepress";
import { homepage, repository, version } from "../../package.json";

const repositoryUrl = repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const socialImage = new URL("readme/intention-kernel-overview.png", homepage).href;
const logo = new URL("intention-kernel-symbol-dark.png", homepage).href;
const imageAlt = "Intention Kernel: models propose, the kernel decides. Interpret, authorize, execute, ground and commit.";
const creators = [
  {
    "@type": "Person",
    name: "Claudio Gonzales",
    url: "https://github.com/claudiojgonzalez",
    sameAs: ["https://github.com/claudiojgonzalez"],
  },
  {
    "@type": "Person",
    name: "Juan Pablo Paillet",
    url: "https://pailletjp.com",
    sameAs: ["https://github.com/PailletJuanPablo"],
  },
];

export function createMetadata({ page, title, description }: TransformContext): HeadConfig[] {
  if (page === "404.md") return [["meta", { name: "robots", content: "noindex, follow" }]];

  // Canonical URLs describe the public site, including during local builds.
  const relativeUrl = page.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, ".html");
  const canonicalUrl = new URL(relativeUrl, homepage).href;
  const head: HeadConfig[] = [
    ["link", { rel: "canonical", href: canonicalUrl }],
    ["link", { rel: "sitemap", type: "application/xml", href: new URL("sitemap.xml", homepage).href }],
    ["meta", { name: "author", content: creators.map((creator) => creator.name).join(", ") }],
    ["meta", { name: "robots", content: "index, follow, max-image-preview:large" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Intention Kernel" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { property: "og:url", content: canonicalUrl }],
    ["meta", { property: "og:image", content: socialImage }],
    ["meta", { property: "og:image:type", content: "image/png" }],
    ["meta", { property: "og:image:width", content: "1280" }],
    ["meta", { property: "og:image:height", content: "672" }],
    ["meta", { property: "og:image:alt", content: imageAlt }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: title }],
    ["meta", { name: "twitter:description", content: description }],
    ["meta", { name: "twitter:image", content: socialImage }],
    ["meta", { name: "twitter:image:alt", content: imageAlt }],
  ];

  if (page === "index.md") {
    head.push(["script", { type: "application/ld+json" }, JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          "@id": `${homepage}#website`,
          name: "Intention Kernel",
          url: homepage,
          description,
          inLanguage: "en-US",
          image: logo,
          creator: creators,
          about: { "@id": `${homepage}#project` },
        },
        {
          "@type": "SoftwareSourceCode",
          "@id": `${homepage}#project`,
          name: "Intention Kernel",
          url: homepage,
          description,
          codeRepository: repositoryUrl,
          programmingLanguage: "TypeScript",
          runtimePlatform: "Node.js",
          version,
          license: "https://www.apache.org/licenses/LICENSE-2.0",
          image: logo,
          thumbnailUrl: socialImage,
          creator: creators,
        },
      ],
    }).replace(/</g, "\\u003c")]);
  }

  return head;
}
