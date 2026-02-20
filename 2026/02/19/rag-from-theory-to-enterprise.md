# On RAG Applications: From Theory to Enterprise Setups

**Published on:** 2026/02/19

**Tags:** ai, llm, rag, embeddings, search, bm25, enterprise, architecture

---

RAG — Retrieval-Augmented Generation — has become the default answer to nearly every enterprise AI question in the last two years. Need a chatbot over your docs? RAG. Need to search medical records? RAG. Need to find relevant code? RAG. Need to answer questions about your internal wiki? RAG.

The problem is that most teams jump straight to the most complex version of RAG — chunking, embedding models, vector databases, re-rankers, LLM orchestration — without asking a more fundamental question: **what kind of retrieval does this problem actually need?**

This article walks through the full retrieval landscape as it stands in 2026: what each approach is actually good for, where the hype has outrun the evidence, and how to think about retrieval decisions in production systems. The goal is not to dismiss RAG — it's a genuinely useful pattern — but to put it in its proper place alongside simpler, often better-suited alternatives.

---

## The Retrieval Spectrum

Before talking about RAG, it's worth being precise about what "retrieval" means. There is a spectrum:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>The Retrieval Spectrum</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart LR
    EM["Exact Match\ngrep · regex · SQL ="]
    SQL["Structured Queries\nSQL · filters · Text2SQL"]
    BM25["Lexical Search\nBM25 · TF-IDF"]
    HYB["Hybrid\nBM25 + Semantic"]
    VEC["Dense Retrieval\nVector Embeddings"]
    GRAPH["Graph-based\nKnowledge Graph"]
    FINE["Fine-tuned\nDomain Embeddings"]

    EM -->|+complexity| SQL
    SQL -->|+complexity| BM25
    BM25 -->|+complexity| HYB
    HYB -->|+complexity| VEC
    VEC -->|+complexity| GRAPH
    GRAPH -->|+complexity| FINE

    EM:::l1
    SQL:::l2
    BM25:::l3
    HYB:::l4
    VEC:::l5
    GRAPH:::l6
    FINE:::l7

    classDef l1 fill:#0a2a0a,stroke:#39ff14,color:#39ff14
    classDef l2 fill:#143300,stroke:#55ff22,color:#55ff22
    classDef l3 fill:#1e3d00,stroke:#88ff44,color:#88ff44
    classDef l4 fill:#3a2a00,stroke:#ffaa00,color:#ffaa00
    classDef l5 fill:#3a1500,stroke:#ff7700,color:#ff7700
    classDef l6 fill:#3a0800,stroke:#ff4400,color:#ff4400
    classDef l7 fill:#3a0000,stroke:#ff0000,color:#ff0000
</div>
</div>
</div>

Each step adds complexity, latency, infrastructure cost, and opacity. Each step is only justified when the previous one demonstrably fails on your actual data and queries.

The mistake I see most often in 2026 is teams starting at step five — dense vector retrieval — without ever establishing whether step two or three would have sufficed.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Retrieval Decision Flow</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart LR
    Q([User Query]) --> S1{Structured data?\ndate · ID · status}
    S1 -->|Yes| SQL[SQL + Filters\nText2SQL]
    S1 -->|No| S2{Expert users?\nControlled vocab?}
    S2 -->|Yes| BM25[BM25\nElasticsearch]
    S2 -->|No| S3{Paraphrase or\ncross-lingual?}
    S3 -->|No| BM25
    S3 -->|Yes| S4{Domain-specific\nembeddings available?}
    S4 -->|No| HYBRID_GENERIC[Hybrid BM25 +\nGeneric Embeddings]
    S4 -->|Yes| HYBRID_DOMAIN[Hybrid BM25 +\nDomain Embeddings]
    S2 -->|Relationships| S5{Entity graph\nneeded?}
    S5 -->|Yes| GRAPH[Graph RAG\nKnowledge Graph]
    S5 -->|No| BM25

    SQL:::good
    BM25:::good
    HYBRID_DOMAIN:::medium
    HYBRID_GENERIC:::medium
    GRAPH:::complex

    classDef good fill:#1a3a1a,stroke:#39ff14,color:#39ff14
    classDef medium fill:#3a2a00,stroke:#ffaa00,color:#ffaa00
    classDef complex fill:#3a0000,stroke:#ff4444,color:#ff4444
</div>
</div>
</div>

---

## What RAG Actually Is

RAG is not a retrieval algorithm. It's a generation pattern: given a user query, retrieve relevant context from a corpus, and inject that context into an LLM prompt to ground the response.

```
User query → Retrieval → Context chunks → LLM prompt → Response
```

The retrieval step can be anything: SQL, BM25, vector search, a simple grep. The LLM generation step is largely independent of how you retrieve. Most of the architectural complexity people associate with "RAG" lives in the retrieval step, and that's where the decisions matter.

What you retrieve — and how — determines accuracy, latency, cost, and maintainability far more than which LLM you use.

---

## The Semantic Search Myth

Vector embeddings map text to points in a high-dimensional space such that semantically similar texts end up geometrically close. The pitch is compelling: you can find documents "about the same thing" even if they use completely different words.

This works well in demos. It falls apart in production in predictable ways:

**Generic embeddings don't understand your domain.** A general-purpose model like `text-embedding-ada-002` or `multilingual-e5-large` was trained on broad internet text. It learned that "cardiac arrest" and "heart attack" are similar. It did not learn the clinical distinction between them, nor does it understand ICD-10 coding conventions, drug interaction terminology, or the structure of a radiology report. In a medical system, this produces retrieval that is semantically plausible but clinically imprecise.

**Semantic similarity is not the same as relevance.** "The patient was discharged in good condition" and "the patient was discharged in critical condition" are semantically nearly identical — same structure, similar tokens, high cosine similarity. Their clinical meaning is opposite. BM25 scores them differently if your query contains "critical" because it matches the exact token. Vectors don't.

**Vectors encode context, not facts.** A document saying "the procedure was not performed due to contraindications" may cluster near "procedure performed" because the surrounding context is similar. Exact match systems don't have this problem.

**Chunking is lossy by design.** To embed a long document, you split it into chunks. You immediately lose cross-chunk relationships: a conclusion that references a table from three pages earlier, a diagnosis that only makes sense in context of the history section, a code function that calls a helper defined elsewhere. The chunk is the unit of retrieval, but meaning often lives at document or multi-document level.

**Evaluation is systematically skipped.** Most teams don't measure retrieval quality before shipping. They see that the LLM produces coherent-sounding answers and assume retrieval is working. The LLM can paper over poor retrieval in demos — it cannot do so reliably in production.

None of this means vector search is useless. It means it's a specialized tool for specific problems, not a universal retrieval layer.

---

## BM25: The Algorithm You're Probably Ignoring

BM25 (Best Matching 25) is a probabilistic ranking function from 1994 that remains competitive with — and often outperforms — neural retrieval on real-world benchmarks. It's fast, interpretable, requires no GPU, and runs on a single machine.

### How BM25 Works

BM25 scores documents by how well they match a query, weighting term frequency against document length and corpus-wide inverse document frequency:

```
score(D, Q) = Σ IDF(qi) · (tf(qi, D) · (k1 + 1)) / (tf(qi, D) + k1 · (1 - b + b · |D| / avgdl))
```

Where:
- `tf(qi, D)` — term frequency of query term `qi` in document `D`
- `IDF(qi)` — inverse document frequency (rare terms score higher)
- `|D|` — document length
- `avgdl` — average document length in the corpus
- `k1`, `b` — tunable parameters (typically k1=1.5, b=0.75)

The key property: BM25 saturates term frequency contribution. A document mentioning "pneumonia" ten times doesn't score ten times higher than one mentioning it once. Length normalization prevents longer documents from dominating by volume alone.

### BM25 in Practice

With Elasticsearch or OpenSearch, BM25 is the default scorer — production-tested at massive scale, runs in milliseconds, fully interpretable:

```json
GET /medical_records/_search
{
  "query": {
    "bool": {
      "must": {
        "match": {
          "clinical_notes": {
            "query": "food poisoning gastrointestinal symptoms",
            "fuzziness": "AUTO"
          }
        }
      },
      "filter": [
        { "range": { "admission_date": { "gte": "2026-02-13", "lte": "2026-02-16" } } },
        { "term": { "department": "emergency" } }
      ]
    }
  }
}
```

No embedding model. No vector database. No GPU. And you can explain to a clinician exactly why a record was returned: "it contained these terms and matched your date filter."

With Python and a local corpus, `rank_bm25` is a minimal dependency:

```python
from rank_bm25 import BM25Okapi
import re

def tokenize(text):
    return re.findall(r'\b\w+\b', text.lower())

corpus = [
    "Patient admitted with nausea vomiting diarrhea after restaurant meal",
    "Cardiac catheterization performed without complications",
    "Food poisoning suspected Salmonella pending culture results",
    "Routine postoperative check hysterectomy recovery normal",
]

tokenized_corpus = [tokenize(doc) for doc in corpus]
bm25 = BM25Okapi(tokenized_corpus)

query = tokenize("food poisoning gastrointestinal this weekend")
scores = bm25.get_scores(query)

for doc, score in sorted(zip(corpus, scores), key=lambda x: -x[1]):
    print(f"{score:.3f} | {doc}")
```

Output:
```
3.421 | Food poisoning suspected Salmonella pending culture results
2.108 | Patient admitted with nausea vomiting diarrhea after restaurant meal
0.000 | Cardiac catheterization performed without complications
0.000 | Routine postoperative check hysterectomy recovery normal
```

### Where BM25 Wins

| Scenario | Why BM25 works |
|----------|---------------|
| Medical records with ICD codes | Exact code matching, no semantic drift |
| Legal documents | Precise term matching required — synonyms are legally dangerous |
| Log analysis | Structured token patterns, no paraphrase needed |
| Academic papers | Keyword queries where exact terminology matters |
| Internal documentation | Expert users who know the vocabulary |
| Multilingual enterprise corpora | Language-aware tokenization, no embedding model needed |

BM25 loses when users don't know the vocabulary — when "chest pain" needs to match records that say "precordial discomfort". That's a real problem in consumer-facing search. It's a smaller problem in expert-facing systems where vocabulary is controlled.

---

## The Case for Grep in Code Search

For searching codebases, exact string matching and regex remain the most effective tools at most scales. This is not a controversial claim — it's just rarely stated explicitly against the RAG hype.

Consider what code search queries actually look like:

- Find where `authenticate()` is called
- Find all usages of a deprecated API
- Find files that import a specific module
- Find where a config key is read
- Find all SQL queries that touch a specific table
- Find the definition of a class or function

These are structural, exact-match queries. Grep, ripgrep, or ctags solve them correctly, instantly, with zero false positives from semantic drift.

```bash
# Find all callers of authenticate()
rg 'authenticate\(' --type py -n

# Find all files importing a deprecated module
rg 'from legacy_auth import' --type py -l

# Find SQL queries touching the users table
rg 'FROM\s+users\b' --type sql -n

# Find class definition
rg '^class AuthService' --type py
```

These run in milliseconds on a codebase with millions of lines. Exact locations. No false positives from embedding approximation.

Semantic code search — embedding function names and docstrings, building vector indices over AST nodes — adds genuine value in a narrow scenario: "find functions that do something like X" when you don't know the function's name. That's the hard case, not the common case.

The right starting point for enterprise code search is almost always: ripgrep or an AST-aware tool (Tree-sitter, ctags, LSP-based indexing). Layer semantic search on top only when exact matching provably fails on your actual queries.

---

## The Rise of Agentic Coding: Grep Wins Again

Perhaps the most telling validation of exact-match retrieval in 2026 comes from agentic coding tools themselves. Claude Code, Cursor, Copilot Workspace, Devin — these are systems that need to retrieve relevant code context continuously, at low latency, to function. And the retrieval approach they converge on is instructive.

Claude Code — the tool running this session — exposes its retrieval primitives directly: `Glob` for file pattern matching, `Grep` for content search, `Read` for targeted file access. When navigating a codebase to fix a bug or add a feature, the retrieval flow looks like this:

```
"Find where authentication is handled"
→ Grep: pattern='def authenticate|class Auth', type=py
→ Read: /src/auth/service.py
→ Grep: pattern='authenticate\(', type=py  (find callers)
→ Read: /src/api/routes.py (lines 42-80)
```

No embedding model. No vector index. No cosine similarity. Deterministic, exhaustive, fast.

This is not a limitation — it's the right tool for the job. Code has properties that make exact match strictly superior for most retrieval tasks:

**Names are canonical.** A function called `validate_token` is called `validate_token` everywhere. There is no paraphrase. Semantic search adds noise without adding recall.

**Structure is machine-readable.** Imports, class definitions, function signatures, call sites — these are syntactically unambiguous. grep and Tree-sitter parse them perfectly. Embeddings approximate them probabilistically.

**Recall must be exhaustive.** If you want every caller of a deprecated function, you need every caller. Approximate nearest neighbor retrieval — the mechanism behind vector search — is approximate by design. It will miss some. In code, missing one is a bug.

**Context is local.** The relevant context for most code tasks lives in a small number of files. An agent can read those files directly once located. There is no need to rank thousands of chunks by semantic similarity — the right files are findable by exact path or exact symbol name.

Where do agentic coding tools use semantic search? For the hard case: "find code that does something conceptually similar to X" when you don't know the symbol name. Cursor's codebase indexing and GitHub Copilot's workspace search use embeddings for this. But this is the minority of retrieval operations in an agentic coding session, not the default.

The broader point: the most capable AI coding systems in 2026 have implicitly validated the retrieval spectrum argument. They use exact match and structural search as the primary retrieval layer, reserving semantic search for the narrow cases where exact match provably fails.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Agentic Coding Retrieval Flow</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart LR
    TASK([Coding Task]) --> Q1{Know the\nsymbol name?}
    Q1 -->|Yes| GREP[Grep / Glob\nexact match]
    Q1 -->|No| Q2{Know the\nfile path?}
    Q2 -->|Yes| READ[Read\ndirect access]
    Q2 -->|No| Q3{Structural\npattern?}
    Q3 -->|Yes| AST[AST Search\nTree-sitter · ctags]
    Q3 -->|No| SEM[Semantic Search\nlast resort]

    GREP --> CTX[Relevant context\ninjected into LLM]
    READ --> CTX
    AST --> CTX
    SEM --> CTX

    GREP:::good
    READ:::good
    AST:::good
    SEM:::last

    classDef good fill:#1a3a1a,stroke:#39ff14,color:#39ff14
    classDef last fill:#3a1500,stroke:#ff7700,color:#ff7700
</div>
</div>
</div>

---

## Retrieval by Domain: What Actually Works in 2026

Different domains have different retrieval characteristics. Here's an honest assessment of where each approach lands in production.

### Healthcare and Clinical Systems

Healthcare is a case where the stakes of retrieval errors are high and the vocabulary is highly specialized.

**What works:**
- **Structured queries (SQL)** for the majority of clinical data queries — date ranges, ICD-10 codes, department filters, patient IDs. Most queries doctors actually run are structured.
- **BM25 with medical tokenization** for free-text clinical note search. With a good analyzer (stemming, medical abbreviation expansion), BM25 performs remarkably well.
- **Text2SQL** for natural language interfaces over structured data — let the LLM translate intent to SQL, not to a vector query.
- **Domain-specific embeddings** (ClinicalBERT, PubMedBERT) when you genuinely need unstructured note similarity — similar case finding, cohort identification.

**What doesn't work:**
- Generic embedding models (`multilingual-e5-large`, `ada-002`) on clinical text. The model doesn't understand ICD codes, clinical abbreviations, or the semantic importance of negation ("patient denies chest pain" is not similar to "patient reports chest pain", but a generic embedding will score them close).
- Vector search for queries that are fundamentally structured (date + diagnosis + field). Adding semantic search here introduces non-determinism into a domain that legally requires auditability.

**The auditability problem.** In healthcare, "why was this record returned?" must have a clear, documentable answer. "Because its embedding was 0.87 similar to your query" is not an acceptable answer in a clinical or regulatory context. Structured and lexical retrieval are auditable. Vector retrieval is not, by default.

### Legal

Legal search has the same fundamental property: precision over recall, auditability required, terminology is controlled and exact.

**What works:**
- BM25 over legal corpora — established commercial legal search systems (Westlaw, LexisNexis) have been doing this for decades and still mostly use lexical approaches
- Exact citation lookup — `rg 'Rodriguez v. United States'`
- Structured filters: jurisdiction, date, court level, document type
- Hybrid search for precedent finding, where conceptual similarity matters but must be combined with exact term matching

**What doesn't work:**
- Pure semantic search for legal research. "Reasonable standard of care" and "duty of care" are semantically similar but legally distinct concepts in different jurisdictions. Generic embeddings don't know this.

### Software Development

**What works:**
- ripgrep and exact match for the vast majority of code navigation queries
- AST-aware search (Tree-sitter) for structural queries: "find all function calls with more than 5 arguments", "find all classes that implement interface X"
- BM25 over documentation and comments
- Semantic search for "find code that does X conceptually" — the one case where vectors add genuine value

**What doesn't work:**
- Vector-only code search for deterministic queries. If you want to find all callers of a function, you want exhaustive recall. Vector search will miss some with high confidence — that's inherent to approximate nearest neighbor retrieval.

### Enterprise Documents and Knowledge Bases

This is where RAG with semantic search has the strongest genuine case — heterogeneous document corpora where users don't always know the right terms and queries are exploratory.

**What works:**
- Hybrid retrieval (BM25 + semantic) with Reciprocal Rank Fusion
- Domain-tuned embedding models fine-tuned on your actual query logs
- Metadata filters combined with semantic search (department, author, date, document type)
- Re-ranking with a cross-encoder after initial retrieval

**What doesn't work:**
- Generic embeddings without fine-tuning, especially if your documents use internal terminology, product names, or abbreviations the embedding model has never seen
- Single-stage pure vector retrieval without lexical backup

### Research and Scientific Literature

**What works:**
- BM25 for keyword queries (PubMed's search is BM25-based and serves hundreds of millions of queries)
- Graph RAG for citation networks, entity relationship traversal (compound → disease → paper)
- Fine-tuned scientific embeddings (SciBERT, BioLinkBERT) for semantic paper similarity and related work discovery

**What doesn't work:**
- Generic embeddings on highly technical text. "Attention is all you need" should not retrieve documents about paying attention or human needs.

---

## Graph RAG: When Relationships Matter

Graph-based retrieval adds genuine value when **relationships between entities** are part of the answer — not just the documents themselves.

Examples where graph traversal is the right primitive:
- "What drugs interact with this patient's current medications?" — a typed relationship graph
- "What papers cite the study that established X?" — a citation graph
- "Which code modules would be affected if I change this interface?" — a dependency graph
- "What policies reference this regulation?" — a knowledge graph over enterprise documents

```python
# Drug interaction: graph traversal, not semantic search
DRUG_INTERACTIONS = {
    "warfarin": {"aspirin": "increased_bleeding_risk", "ibuprofen": "increased_bleeding_risk"},
    "metformin": {"contrast_dye": "lactic_acidosis_risk"},
    "lisinopril": {"potassium": "hyperkalemia_risk"},
}

def check_interactions(medications: list[str]) -> list[dict]:
    interactions = []
    for drug in medications:
        for other in medications:
            if other != drug and other in DRUG_INTERACTIONS.get(drug, {}):
                interactions.append({
                    "drug_a": drug,
                    "drug_b": other,
                    "risk": DRUG_INTERACTIONS[drug][other]
                })
    return interactions
```

Drug interactions are exact facts, not fuzzy similarities. Adding vector embeddings here to "find similar interactions" would be wrong.

Microsoft's GraphRAG paper (2024) established the pattern of combining entity extraction, knowledge graph construction, and LLM summarization for corpus-wide question answering — questions like "what are the main themes across these 10,000 documents?" that single-document retrieval can't answer. It's genuinely useful for that specific class of question. It's expensive to build and maintain for everything else.

Graph RAG makes sense when:
- Your corpus has rich entity relationships (biomedical, legal, technical standards)
- Questions require aggregating across many documents, not finding the right one
- You can afford the graph construction and maintenance cost

It doesn't make sense as a first choice for point-retrieval ("find the document that answers X").

---

## Hybrid Retrieval: Best of Both Worlds

When your problem genuinely needs semantic similarity, the evidence consistently shows hybrid approaches outperform either BM25 or vector search alone. The BEIR benchmark (a standard heterogeneous retrieval benchmark across 18 datasets) shows this across nearly every domain.

The standard approach: retrieve candidates from both BM25 and dense retrieval, then fuse the rankings with Reciprocal Rank Fusion (RRF).

```python
def reciprocal_rank_fusion(rankings: list[list[str]], k: int = 60) -> list[str]:
    """
    Merge multiple ranked lists using RRF.
    k=60 is the standard constant (Cormack et al. 2009).
    """
    scores = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking):
            scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank + 1)
    return sorted(scores, key=scores.get, reverse=True)

bm25_results  = ["doc_42", "doc_7",  "doc_103", "doc_55"]
vector_results = ["doc_7",  "doc_88", "doc_42",  "doc_201"]

fused = reciprocal_rank_fusion([bm25_results, vector_results])
# doc_7 and doc_42 appear in both → boosted. Others get partial credit.
```

Elasticsearch 8.x and OpenSearch both support hybrid search natively. The weight between lexical and semantic components is tunable — and you should tune it against your actual evaluation set, not leave it at defaults.

In most enterprise document corpora, BM25 deserves a weight of 0.5–0.7 even when hybrid is appropriate. Semantic search is usually the minority contributor.

---

## The Embedding Model Problem

If you use vector embeddings, the embedding model is the most consequential architectural decision in your pipeline. Generic models encode generic semantic similarity. Domain models encode domain-relevant similarity.

| Model | Training Data | Best For |
|-------|--------------|----------|
| `text-embedding-ada-002` | Web text | General-purpose, multilingual |
| `multilingual-e5-large` | Web text, multilingual | Cross-lingual document retrieval |
| `BioBERT` | PubMed + PMC | Biomedical literature |
| `ClinicalBERT` | MIMIC-III clinical notes | Clinical text, EHR |
| `CodeBERT` | GitHub code | Code search and similarity |
| `LegalBERT` | Legal corpora | Legal documents |
| `FinBERT` | Financial reports | Financial text |
| `SciBERT` | Semantic Scholar papers | Scientific literature |

Using a generic model on a specialized domain isn't a minor suboptimality — it's a category error. ClinicalBERT understands that "SOB" means shortness of breath. It knows "pt c/o CP x3d" is a patient complaining of chest pain for three days. A generic model does not.

Beyond pre-trained domain models, **fine-tuning on your own data** is where real production gains come from. If you have query logs and relevance signals (clicks, ratings, expert annotation), fine-tuning an embedding model on that data will outperform any off-the-shelf model on your specific distribution.

```python
from sentence_transformers import SentenceTransformer, InputExample, losses
from torch.utils.data import DataLoader

train_examples = [
    InputExample(
        texts=["food poisoning weekend admissions",
               "Patient admitted Friday evening with acute gastroenteritis, suspected Salmonella"],
        label=1.0
    ),
    InputExample(
        texts=["food poisoning weekend admissions",
               "Routine post-op follow-up, patient discharged in good condition"],
        label=0.0
    ),
    # ... thousands of domain-specific pairs
]

model = SentenceTransformer('emilyalsentzer/Bio_ClinicalBERT')
train_dataloader = DataLoader(train_examples, shuffle=True, batch_size=16)
train_loss = losses.CosineSimilarityLoss(model)

model.fit(
    train_objectives=[(train_dataloader, train_loss)],
    epochs=3,
    warmup_steps=100,
    output_path='./domain-search-model'
)
```

This produces a model calibrated to your actual query distribution. It's not a research technique — it's what production search teams do.

---

## Evaluating Retrieval: The Question Nobody Asks

Here is a question I rarely see answered in RAG architecture posts: **how do you know your retrieval is actually good?**

Before adding any embedding model, establish a retrieval evaluation baseline. The standard metrics:

**Recall@K**: Of the relevant documents for a query, what fraction appear in the top K results?
**MRR (Mean Reciprocal Rank)**: On average, at what rank does the first relevant document appear?
**NDCG (Normalized Discounted Cumulative Gain)**: How well are results ordered by relevance?

```python
def recall_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    return len(set(retrieved[:k]) & relevant) / len(relevant)

def mean_reciprocal_rank(
    retrieved_lists: list[list[str]],
    relevant_sets: list[set[str]]
) -> float:
    reciprocal_ranks = []
    for retrieved, relevant in zip(retrieved_lists, relevant_sets):
        for rank, doc_id in enumerate(retrieved, 1):
            if doc_id in relevant:
                reciprocal_ranks.append(1 / rank)
                break
        else:
            reciprocal_ranks.append(0)
    return sum(reciprocal_ranks) / len(reciprocal_ranks)
```

The process:
1. Collect 100–500 representative queries from real users or expert curation
2. Annotate relevant documents for each query
3. Measure BM25 baseline (Recall@10, MRR)
4. Add vector search, measure again
5. Add hybrid, measure again
6. Only ship added complexity if the numbers justify it

If you can't do step 2 — if you have no way to evaluate retrieval quality — you are shipping a system you cannot validate. The LLM will produce fluent answers regardless of whether retrieval is working. Fluency is not correctness.

RAGAS and TruLens provide tooling for end-to-end RAG evaluation. But the foundational requirement is a labeled retrieval evaluation set. There is no shortcut around this.

---

## RAG Types: A Reference Table

| RAG Type | Retrieval Method | Best For | Real Example | When to Avoid |
|----------|-----------------|----------|--------------|---------------|
| **Exact Match** | grep, regex, SQL `=` | Structured data, controlled vocabulary | Code search; patient lookup by ID or ICD code | When users paraphrase or vocabulary varies |
| **Lexical (BM25)** | BM25, TF-IDF, Elasticsearch | Keyword-rich documents, expert users | Legal contracts, clinical notes, internal wikis, log search | Heavy paraphrase variation; cross-lingual queries |
| **Text2SQL** | LLM → SQL → RDBMS | Natural language over relational data | "Show patients admitted this weekend with diagnosis X" | Unstructured text retrieval; similarity-based search |
| **Semantic** | Dense embeddings + vector DB | Paraphrase variation; exploratory queries; cross-lingual | Consumer product search; heterogeneous enterprise docs | Clinical coding; code search; anything requiring auditability |
| **Hybrid** | BM25 + embeddings + RRF | Mixed query types over the same corpus | Enterprise knowledge bases; research paper search | Simple corpora where BM25 alone reaches 90%+ recall |
| **Graph** | Knowledge graph traversal + LLM | Answers require following typed entity relationships | Drug interactions; citation networks; policy dependency graphs | Flat corpora; point-retrieval queries |
| **Fine-tuned Embedding** | Domain-specific embedding model | Specialized terminology; labeled evaluation data exists | Clinical note similarity; legal precedent retrieval | No labeled data — fine-tuning without evaluation is blind |

The table is roughly ordered by complexity and infrastructure cost. Start at the top. Move down only when the simpler approach demonstrably fails on your actual queries.

---

## The Enterprise Reality in 2026

Here is what production RAG systems actually look like in organizations that have shipped and maintained them:

**What gets used:**
- BM25 (Elasticsearch/OpenSearch) as the primary retrieval layer in most cases
- Structured filters (date, category, author, department) applied before or alongside retrieval
- Text2SQL for data that lives in relational databases
- A targeted vector index over specific content where semantic search demonstrably helps
- Exact-match systems for code and structured data search

**What gets abandoned:**
- Complex multi-stage pipelines (query decomposition → sub-queries → merge → re-rank → generate) — too fragile, too expensive to debug, latency unpredictable
- Pure vector-only retrieval — precision problems and lack of auditability
- Real-time embedding of new documents — write latency spikes unpredictably
- Very large chunk sizes — too much noise per chunk; LLM gets confused
- Very small chunk sizes — context fragmentation, cross-chunk references lost

**What actually scales:**
- Query caching for repeated searches (a small cache covers a disproportionate share of queries)
- Offline batch embedding with scheduled re-indexing
- Monitoring retrieval quality over time as document distributions shift
- Human feedback loops to improve relevance — even implicit signals like clicks help

The boring answer is usually right. Elasticsearch with BM25 and filters covers 80% of enterprise search needs. Add domain-specific embeddings for the remaining 20% where semantic similarity is genuinely needed. Evaluate continuously.

---

## Decision Framework

When designing retrieval for a system, work through this in order:

```
1. Is the query structured? (date, ID, category, status)
   → YES: SQL + filters. Done.

2. Do users know the exact terms? (expert domain, controlled vocabulary)
   → YES: BM25. Done.

3. Is the data in a relational database and the query is natural language?
   → YES: Text2SQL. Done.

4. Are there synonyms, paraphrases, or cross-lingual needs?
   → YES: Add domain-specific embeddings.
   → Use hybrid (BM25 + semantic), not semantic alone.

5. Are relationships between entities part of the answer?
   → YES: Graph traversal for those relationships.
   → Combine with lexical/semantic for document retrieval.

6. Do you have labeled evaluation data?
   → NO: Build it before shipping.
       You cannot measure what you cannot evaluate.
```

For most domains: step 1 covers the majority of structured data queries. Step 2 covers most document search. Step 3 covers natural language interfaces to databases. Steps 4–5 are warranted only when you can demonstrate the previous steps fail on your actual query distribution.

---

## Resources

- [BM25 paper — Robertson & Zaragoza (2009)](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf)
- [BEIR Benchmark](https://github.com/beir-cellar/beir) — heterogeneous retrieval evaluation; BM25 is competitive on most datasets
- [MTEB Leaderboard](https://huggingface.co/spaces/mteb/leaderboard) — embedding model benchmarks across tasks and languages
- [sentence-transformers](https://www.sbert.net/) — library for embedding models and fine-tuning
- [ClinicalBERT](https://huggingface.co/emilyalsentzer/Bio_ClinicalBERT) — BERT fine-tuned on MIMIC-III clinical notes
- [Reciprocal Rank Fusion — Cormack et al. (2009)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [GraphRAG — Microsoft Research (2024)](https://arxiv.org/abs/2404.16130)
- [rank_bm25](https://github.com/dorianbrown/rank_bm25) — Python BM25 implementation
- [RAGAS](https://github.com/explodinggradients/ragas) — RAG evaluation framework
- [Elasticsearch hybrid search](https://www.elastic.co/guide/en/elasticsearch/reference/current/knn-search.html)
