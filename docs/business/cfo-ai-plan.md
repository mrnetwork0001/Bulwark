# Bulwark business plan in cfo.ai

Built on 2026-10-11 in **cfo.ai** (workspace "MrNetwork CFOAI", org 103318) with the cfo.ai MCP tools, following cfo.ai's `build-model` and `build-visualizations` skills. This is the hackathon evidence for "use cfo.ai to plan its business" (pricing, costs, revenue, runway).

- **Scenario:** `Bulwark plan (neatHack)`. It was created from Main, and every edit names it. Main Scenario is unchanged. Its calendar has Last close 2026-10-31, so the 36-month plan from 2026-11 to 2029-10 is the Forecast range.
- **Read-only share link** (opens all five pages in this scenario): https://app.cfo.ai/s/xAu-NTAidKxJcCm7
- **Pages**
  1. **Bulwark business plan (summary):** narrative, *Key results* table, *Plan-year P&L and cash* table, and a Canvas chart of ARR and cash balance (2026-11 to 2029-10).
  2. **1. Pricing & unit economics:** *Measured run costs*, *Cost assumptions*, and *Plans: pricing, mix, COGS and gross margin*.
  3. **2. Market (Crustdata):** *Market by headcount band (Crustdata, 2026-10-11)* and *TAM / SAM / SOM summary*.
  4. **3. Revenue plan:** *Growth drivers (adoption and churn)* and *Revenue plan (monthly)*, 36 months.
  5. **4. Costs & runway:** *Operating cost and funding assumptions* and *Costs, burn, cash and runway (monthly)*.

Every output in cfo.ai is a formula that traces back to an editable input, so changing churn, adoption, prices, cadence or salaries recalculates revenue, COGS, burn, cash and runway. The numbers below are read back from the saved cfo.ai tables (`inspect_table_blocks`). They match the repo's `unit-economics.md` and `market-sizing.md` exactly.

## Basis labels

| Label | Meaning |
|---|---|
| **MEASURED (runs)** | From `summary.json` of 4 real Bulwark loop runs on 2026-10-11 (`npm run economics`, [unit-economics.md](unit-economics.md)) |
| **MEASURED (Crustdata)** | Company counts from the Crustdata API, 2026-10-11 (`npm run market`, [market-sizing.md](market-sizing.md)) |
| **ASSUMPTION** | A planning choice, not market data |
| **DERIVED** | A cfo.ai formula over the inputs above |

## 1. Pricing and unit economics

### Measured run costs (MEASURED, runs)

| Metric | Value |
|---|---|
| Cost per loop run | $0.0633 |
| LLM cost per loop run (0G Compute Router list prices) | $0.0595 (94.0%) |
| Compute cost per loop run (wall-clock × $0.10/h VM, assumed rate) | $0.0038 (6.0%) |
| Cost per fault fixed | $0.0133 |
| Cost per trial (simulated target) | $0.0000145 |
| Trials per loop run | 4,355 |
| Wall-clock per loop run | 137 s |
| Real-LLM cost per trial, `claude-sonnet-5` target (leaderboard) | $0.0172 |

### Cost assumptions (ASSUMPTION)

| Input | Value |
|---|---|
| Real-LLM trials per loop run (one Red scorecard: baseline + 6 faults × 20) | 140 |
| Real-LLM target switch (1 = price a real-model scorecard on every run) | 1 (on, conservative) |
| Compute rate per VM hour | $0.10 |

### Plans

Prices and loop-run cadence are ASSUMPTIONS. Customer mix and agents per customer are DERIVED from the Crustdata SAM counts by headcount band and the assumed agents per company. COGS per agent = runs × (LLM cost per run + switch × 140 × $0.01715) + runs × compute cost per run.

| Plan | Price / agent / month | Loop runs / agent / month | Customer mix | Agents / customer | Revenue / customer / month | COGS / agent / month (used) | **Gross margin (used, real-LLM)** | Gross margin (simulated target) |
|---|---|---|---|---|---|---|---|---|
| Starter | $49 | 4 (weekly) | 92.70% | 1.16 | $56.60 | $9.86 | **79.9%** | 99.5% |
| Team | $199 | 30 (daily) | 6.77% | 3.53 | $702.19 | $73.93 | **62.8%** | 99.0% |
| Enterprise | $799 | 120 (about one per PR) | 0.53% | 12.12 | $9,686.99 | $295.72 | **63.0%** | 99.0% |

The blended gross margin with the plan mix is **68.8%**. The model uses the real-LLM COGS, which is a floor because it prices every run's scorecard on the most expensive leaderboard model. Turning the switch off gives the measured simulated-target margin of about 99%.

## 2. Market (MEASURED, Crustdata API, 2026-10-11)

- **TAM** = companies with Crustdata category "Artificial Intelligence (AI)" OR a professional-network speciality matching any of "AI Agents", "Agentic AI", "LLM", "Large Language Models", "Conversational AI".
- **SAM** = the agent/LLM-speciality subset only (specialities match any of "AI Agents", "Agentic AI", "LLM", "Large Language Models", "Conversational AI"): companies that build or ship agents.
- Companies with no headcount on record are in no band and are left out (unbanded totals: TAM 188,258, SAM 52,405).
- **SOM** = SAM × Year 3 adoption (1%, ASSUMPTION).
- Agents per company and plan by band are ASSUMPTIONS. ARR = companies × agents × price × 12.

| Headcount | TAM companies | SAM companies | Agents / company (ASSUMPTION) | Plan price (ASSUMPTION) | ACV / company |
|---|---|---|---|---|---|
| 1-10 | 120,714 | 33,389 | 1 | $49 Starter | $588 |
| 11-50 | 36,633 | 6,132 | 2 | $49 Starter | $1,176 |
| 51-200 | 10,648 | 2,124 | 3 | $199 Team | $7,164 |
| 201-1000 | 3,565 | 763 | 5 | $199 Team | $11,940 |
| 1001-5000 | 854 | 178 | 10 | $799 Enterprise | $95,880 |
| 5001+ | 369 | 48 | 20 | $799 Enterprise | $191,760 |

| | Companies | Agents | ARR |
|---|---|---|---|
| TAM | 172,783 | 259,669 | $385,549,572 |
| SAM | 42,634 | 58,580 | $77,441,640 |
| SOM (1% of SAM) | 426 | 586 | $774,416 |

## 3. Revenue plan (36 months from 2026-11)

Growth drivers:

- Year-end target paying customers = SAM companies (42,634, MEASURED) × adoption (ASSUMPTION: 0.1% / 0.3% / 1%) = 42.6 / 127.9 / 426.3. Year 1 ends 2027-10, Year 2 2028-10, Year 3 2029-10.
- **Monthly churn: 2% (ASSUMPTION).**
- New customers per month in each plan year are solved so the year ends on target: new = (target − start × 0.98^12) × 0.02 / (1 − 0.98^12). That gives 3.96 / 8.77 / 30.28 new customers per month.
- Paying customers = prior month + new − churned. Agents by plan = customers × mix × agents per customer. MRR = agents × price. ARR = 12 × MRR.

| Plan year | Paying customers (end) | Paying agents (end) | Year-end MRR | **Year-end ARR** | Revenue in year |
|---|---|---|---|---|---|
| Year 1 (2026-11 to 2027-10) | 43 (42.6) | 59 | $6,453 | **$77,442** | $43,500 |
| Year 2 (2027-11 to 2028-10) | 128 (127.9) | 176 | $19,360 | **$232,325** | $164,441 |
| Year 3 (2028-11 to 2029-10) | 426 (426.3) | 586 | $64,535 | **$774,416** | $536,823 |

Year-3 end MRR by plan: Starter $22,370, Team $20,272, Enterprise $21,893.

## 4. Costs, burn and runway

Operating and funding assumptions (all ASSUMPTION):

| Input | Value |
|---|---|
| Founders | 2 |
| Salary per founder per month (modest) | $4,000 |
| Payroll overhead | 15% |
| Salaries and marketing base start | 2027-01 (after the pre-seed) |
| Tools & infra | $500 / month from launch (2026-11) |
| Marketing | $1,500 / month from 2027-01 + 10% of revenue |
| Payment processing | 3% of revenue |
| Pre-seed | $250,000 received 2026-12 |
| Opening cash before launch | $0 |

COGS = paying agents by plan × LLM and compute COGS per agent (DERIVED from the measured run costs).

| Plan year | Revenue | COGS | Gross margin | Operating costs | **Net burn** | **Year-end cash** |
|---|---|---|---|---|---|---|
| Year 1 | $43,500 | $13,571 | 68.8% | $118,655 | **$88,727** | **$161,273** |
| Year 2 | $164,441 | $51,303 | 68.8% | $155,777 | **$42,640** | **$118,634** |
| Year 3 | $536,823 | $167,481 | 68.8% | $204,187 | **−$165,154** (cash generated) | **$283,788** |

Selected months:

| Month | Revenue | Total COGS | Operating costs | Net burn | Cash balance | Runway (months) |
|---|---|---|---|---|---|---|
| 2026-11 | $600 | $187 | $578 | $165 | −$165 (pre-funding) | n/a |
| 2026-12 | $1,187 | $370 | $654 | −$162 | $249,997 | n/a (not burning) |
| 2027-01 | $1,763 | $550 | $11,429 | **$10,216 (peak)** | $239,781 | **23.5** |
| 2027-10 | $6,453 | $2,013 | $12,039 | $7,599 | $161,273 | 21.2 |
| 2028-10 | $19,360 | $6,040 | $13,717 | $397 | **$118,634 (low point)** | 299 |
| 2028-11 | $23,557 | $7,350 | $14,262 | −$1,945 | $120,579 | n/a (cash-flow positive) |
| 2029-10 | $64,535 | $20,134 | $19,590 | −$24,811 | $283,788 | n/a |

## Key results

- **Pricing:** $49 / $199 / $799 per agent per month (ASSUMPTION). Gross margin per plan is 79.9% / 62.8% / 63.0% with real-LLM COGS, 68.8% blended. On measured simulated-target runs it is 99.5% / 99.0% / 99.0%.
- **ARR:** Year 1 **$77,442**, Year 2 **$232,325**, Year 3 **$774,416** (43 → 128 → 426 paying companies).
- **Burn and runway:** peak net burn **$10.2k/month** (2027-01), which gives **23.5 months of runway** on the $250k pre-seed.
- **Break-even:** operating cash-flow positive from **2028-11**, after 22 months of salaried burn. **Cash never runs out** in the 36-month plan: the low point is **$118.6k** (2028-10) and cash ends Year 3 at **$283.8k**.
- **Biggest assumptions:** adoption of SAM (0.1% / 0.3% / 1%), 2% monthly churn, agents per company by band, loop-run cadence per plan, plan prices, the real-LLM scorecard on every run, founder pay and its 2027-01 start, and the $250k pre-seed in 2026-12. None of these are measured.
- **Measured inputs:** Bulwark run costs (cost per loop run, LLM/compute split, cost per fault fixed, cost per trial, real-LLM cost per trial) and Crustdata company counts (TAM/SAM by headcount band).
