# Heimdall - Project Overview

## Purpose
Heimdall (formerly Bifrost Router) is an intelligent LLM router that implements Avengers-style cost↔quality routing with GBDT triage, direct GPT-5/Gemini/Claude OAuth paths, and pluggable auth adapters. It acts as a smart routing layer that optimizes between cost and quality for different types of AI requests.

## Key Features
- **GBDT Triage**: Intelligent bucket selection (cheap/mid/hard) based on request features
- **Avengers-Pro α-score**: Quality vs cost optimization within buckets  
- **Thinking Budget Control**: GPT-5 `reasoning_effort`, Gemini `thinkingBudget`
- **OAuth Support**: Claude Code integration, Gemini OAuth with PKCE
- **429 Fallback**: Immediate non-Anthropic rerouting on rate limits
- **Long Context**: Gemini 2.5 Pro 1M token support

## Tech Stack
- **Runtime**: Node.js 18+ with TypeScript
- **Framework**: Fastify for HTTP services
- **AI SDKs**: Anthropic, OpenAI, Google Generative AI
- **Database**: SQLite (better-sqlite3)
- **Vector Search**: FAISS
- **Testing**: Vitest with coverage
- **Build**: TypeScript compiler
- **Linting**: ESLint + Prettier

## Architecture
- **Router PreHook**: Feature extraction → GBDT triage → Avengers α-score → route decision
- **Catalog Service**: Live model/pricing/capabilities from multiple providers
- **Tuning Service**: Trains GBDT + fits α/thresholds from logs  
- **Auth Adapters**: Modular authentication for different providers