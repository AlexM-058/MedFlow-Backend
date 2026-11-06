

\# MedFlow - Project Instructions



MedFlow is a privacy-first healthcare communication platform

connecting patients, doctors, and AI.



\## Project structure



\- Frontend/: React, TypeScript, Vite

\- Backend/: Node.js, Express, TypeScript

\- AI/edge/: Local data extraction and minimization

\- AI/cloud/: AI orchestration and summarization

\- Database/: PostgreSQL schema and migrations



\## Architecture rules



1\. Always inspect relevant project modules before modifying code.

2\. Use TypeScript throughout the project.

3\. Keep frontend, backend, AI and database contracts consistent.

4\. Never expose API keys or database credentials in frontend code.

5\. Use synthetic medical data only during development.

6\. Do not allow AI to independently diagnose or prescribe.

7\. Do not silently discard patient symptom reports.

8\. Keep medical safety rules separate from LLM-generated text.

9\. Avoid unnecessary frameworks and dependencies.

10\. Document API changes that affect other modules.



