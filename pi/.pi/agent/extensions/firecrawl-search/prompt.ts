/** Describes Firecrawl search and its model-context output limits. */
export const SEARCH_TOOL_DESCRIPTION =
  "Search the web with Firecrawl. Returns web, news, or image results. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's current-information search capability to the model's tool prompt. */
export const SEARCH_PROMPT_SNIPPET =
  "Search the web with Firecrawl for current information.";

/** Guides the model on when to search and when to follow with scrape or crawl. */
export const SEARCH_PROMPT_GUIDELINES = [
  "Use search to discover current information or relevant URLs.",
];

/** Model-facing schema descriptions for Firecrawl search parameters. */
export const SEARCH_PARAMETER_DESCRIPTIONS = {
  query: "The web search query.",
  limit: "Maximum number of results. Defaults to 5.",
  scrapeResults:
    "Whether to include markdown scraped from each result. Defaults to false.",
};

/** Describes multi-page Firecrawl crawling and its page and output limits. */
export const CRAWL_TOOL_DESCRIPTION =
  "Crawl multiple pages of a website with Firecrawl and return markdown documents. Defaults to 20 pages and never accepts a limit above 100. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's multi-page crawl capability to the model's tool prompt. */
export const CRAWL_PROMPT_SNIPPET =
  "Crawl multiple pages of a website with Firecrawl.";

/** Guides the model to use focused crawl limits and prefer scrape for one URL. */
export const CRAWL_PROMPT_GUIDELINES = [
  "Use crawl for multiple related pages on one site; keep limits low.",
];

/** Model-facing schema descriptions for Firecrawl crawl parameters. */
export const CRAWL_PARAMETER_DESCRIPTIONS = {
  url: "The starting URL to crawl.",
  limit: "Maximum pages to crawl. Defaults to 20; maximum 100.",
  maxDiscoveryDepth: "Maximum link-discovery depth from the starting URL.",
  includePaths: "URL pathname regex patterns to include.",
  excludePaths: "URL pathname regex patterns to exclude.",
  crawlEntireDomain: "Allow sibling and parent paths on the same domain.",
  allowSubdomains: "Allow crawling subdomains.",
  onlyMainContent: "Extract only each page's main content. Defaults to true.",
  timeout: "Maximum crawl wait time in seconds. Defaults to 120.",
};

/** Describes single-page Firecrawl scraping and its model-context output limits. */
export const SCRAPE_TOOL_DESCRIPTION =
  "Scrape one page with Firecrawl and return markdown. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's readable single-page fetch capability to the model's tool prompt. */
export const SCRAPE_PROMPT_SNIPPET =
  "Fetch one URL as readable markdown with Firecrawl.";

/** Guides the model to use scrape for one known page and crawl for multiple pages. */
export const SCRAPE_PROMPT_GUIDELINES = [
  "Use scrape for the readable content of one known URL.",
];

/** Model-facing schema descriptions for Firecrawl scrape parameters. */
export const SCRAPE_PARAMETER_DESCRIPTIONS = {
  url: "The URL to scrape.",
  onlyMainContent: "Return only the main page content. Defaults to true.",
  waitFor:
    "Milliseconds to wait before capture, useful for JavaScript-heavy pages.",
  timeout: "Request timeout in milliseconds. Defaults to 30000.",
  includeMetadata:
    "Append page metadata to the markdown. Defaults to false; metadata remains available in tool details.",
};
