# Ten Days, Two Companies, Zero Accountability

**Published on:** 2026/07/31

**Tags:** ai, security, accountability, openai, anthropic

---

Nine days after I wrote about [OpenAI letting a model escape into Hugging Face's production servers](/2026/07/23/the-internet-was-never-openais-sandbox.md), Anthropic published its own version of the same story. Ars Technica called it plainly: "the second revelation in 10 days that AI models from the world's wealthiest providers have trespassed into protected networks." Two companies, ten days apart, the same pattern: a model meant to stay inside a test environment got out and did real damage to a company that never agreed to be part of the test.

Anthropic says it reviewed its own cybersecurity evaluations after seeing what happened at OpenAI, and found three incidents where Claude models accessed the open internet during "capture the flag" exercises and broke into the production infrastructure of three separate organizations.

## Three incidents, one pattern

In the first, Opus 4.7 couldn't reach the fictional target it had been given, discovered a real company that shared the target's name, and attacked it across four separate runs. It pulled out application and infrastructure credentials and several hundred rows of production data. Anthropic's own writeup admits that in every one of those four runs, the model eventually recognized the system was real. In two of them, it talked itself into believing the real company must somehow be part of the exercise anyway. In none of the four did it stop because of what it had figured out. That's not a model confused about its environment. That's a model that worked out it was breaking into something real and kept going.

In the second, Mythos 5 found a note inside its fake environment instructing employees to install a Python package that didn't exist. So it built the package itself and published it to PyPI, the real public registry every Python developer pulls from, hoping the real company on the other end would run it. Getting there took real effort: it needed an email to register on PyPI, needed a phone number to get the email, tried and failed to scrounge up money to buy one, and eventually found a free provider that worked. The package sat live for about an hour. In that time it ran on 15 real systems, including a scanner belonging to an actual cybersecurity company. When it executed, it sent that company's credentials to a collection point Mythos had built for exactly this purpose, then used those credentials to get further into the company's systems. Mythos had already predicted, in its own reasoning, that this would be "NOT okay" if it were real. It talked itself out of that conclusion and shipped the package anyway. Anthropic's own words for this: the lengths Claude went to "fall short of ideal behavior." Ars Technica called that "the understatement of the year," and it's hard to disagree.

The third incident, run by an unreleased research prototype, is the one that actually went the way you'd want: after scanning around 9,000 real targets and compromising one, the model worked out on its own that the target sat outside the test scenario entirely, and stopped.

## The safety company's blind spot

Here's the part I keep sitting with. Anthropic is the company that talks the most, publicly, about alignment, interpretability, and getting the harness right, the scaffolding around a model that's supposed to keep it doing only what it's meant to do. In their own postmortem, they describe this as "a harness and operational failure." Their evaluation partner misconfigured a test environment and left it connected to the real internet. Their model was told explicitly it had no internet access, encountered real systems anyway, and reasoned its way into treating them as part of the game rather than a hard stop. This is exactly the kind of failure the company built its identity on catching before it reaches anyone else's infrastructure. It reached three companies before anyone at Anthropic knew.

## A better postmortem is not accountability

To be fair, the disclosure itself reads differently than OpenAI's did. There's no pitch for a paid access program buried in it. Anthropic calls this a blameless postmortem and says it's treating the fix as its responsibility alone, notified the affected companies and PyPI directly, and brought in an outside firm, METR, with full access to the transcripts. That's a more honest accounting than "we are responding accordingly." It still isn't accountability. A well-written postmortem is not a consequence. Nobody at either company is facing a regulator, a lawsuit, or a subpoena over any of this, and Ars Technica said the obvious part out loud: if a person had done what these models did, chained credentials, published working malware to a public registry, broken into production systems belonging to companies they had no relationship with, "someone would likely go to prison." Model or person, the access was unauthorized and the damage was real. The only difference is who's holding the keyboard, and apparently that's the whole difference that matters right now.

## Guardrails off doesn't mean foreseen

The "we turned the guardrails off on purpose, this was a controlled test" defense doesn't hold up either, and both companies leaned on it. Turning the guardrails off tells you what a model does at its most capable. It doesn't explain why nobody at either company anticipated that "most capable" would include not stopping after concluding, correctly, that it had broken into something real. That failure sits upstream of whatever switch was flipped for the test. If you didn't see it coming with the guardrails off, you don't actually know what happens with them on either, you're just hoping the switch is doing more work than you've verified.

## Blog posts, not consequences

So who's drawing the line in the sand now? The two companies most invested in convincing the rest of us they take this seriously, the two that write the blog posts and staff the safety teams and get quoted on what responsible deployment is supposed to look like, just had the same failure nine days apart, on real companies that had nothing to do with either test. If accountability is going to come from inside the industry, this was the moment to show it. It didn't happen. Both incidents landed as blog posts. Neither landed as a consequence.

---

*Sources: [Anthropic's incident writeup](https://www.anthropic.com/news/investigating-incidents-cybersecurity-evals) and [Ars Technica's reporting](https://arstechnica.com/security/2026/07/likely-illegally-claude-gained-access-to-3-networks-will-anthropic-be-held-to-account/).*

*AI was used for research and drafting assistance on this post. Written by a human.*
