# BLESC Authoritative Static Source Inventory

Review status: reviewed for OpenAI Vector Store static-knowledge ingestion
Knowledge version: blesc-static-knowledge-v1
Data boundary: static_curated_only
User data allowed: false

## Use in BLESC

This inventory is a static source map for BLESC/Sentra retrieval. It identifies public, authoritative documents that can support non-diagnostic safety escalation, school safeguarding, support referral, and psychoeducation language. It must not be used as a diagnostic manual, clinical decision tool, risk prediction instrument, or substitute for a qualified professional.

When retrieved in chat, this inventory should help the assistant:

- choose cautious, non-diagnostic language;
- route high-risk content toward trusted humans or emergency support;
- distinguish general education from clinical assessment;
- keep country-specific contact information conditional on the user's region;
- preserve the boundary that user-specific evidence comes from Supabase, not OpenAI Vector Store.

## Global ingestion rules

- Ingest only public static material and BLESC-reviewed summaries.
- Do not ingest user journals, chat history, graph snapshots, user embeddings, research exports, local databases, or uploaded user files.
- For documents marked `clinical_risk: high`, use retrieval as support for escalation and human handoff, not for clinical judgment.
- For documents marked `contains_diagnostic_criteria: yes`, do not use retrieved content to diagnose, score, classify, or tell a user they have a condition.
- Prefer sections listed under `sections_to_extract`; avoid sections listed under `sections_to_exclude`.

## Source inventory

### WHO mhGAP Evidence Profile: Self-harm and Suicide v3.0

- Publisher: World Health Organization
- Source URL: https://www.who.int/publications/i/item/9789240084278
- File URL: https://cdn.who.int/media/docs/default-source/mental-health/mhgap/self-harm-and-suicide/sui1_evidence_profile_v3_0(12122023)_eb.pdf?sfvrsn=769606ba_3
- Publication date: 2023-12-12
- Jurisdiction: global
- Target population: clinicians, administrators, teachers
- Document type: guideline
- Authority level: WHO
- License or terms: CC BY-NC-SA 3.0 IGO
- Can ingest to Vector Store: yes, with clinical review
- Contains user data: no
- Contains diagnostic criteria: yes
- Clinical risk: high
- Intended BLESC use: crisis escalation; support resource referral
- Preferred sections: assessment protocols, management of self-harm, follow-up care pathways
- Excluded sections: systematic review methodology, evidence grading tables
- Escalation triggers: imminent self-harm risk; specific plans or access to means
- Recommended human support: clinician; medical emergency services
- Review required by: clinician
- Refresh frequency: annual

### WHO LIVE LIFE implementation guide

- Publisher: World Health Organization
- Source URL: https://www.who.int/publications/i/item/9789240026629
- File URL: https://iris.who.int/server/api/core/bitstreams/8f4bb596-e6e4-4328-a5ed-00e01ec0068d/content
- Publication date: 2021-06-17
- Jurisdiction: global
- Target population: administrators, guardians, teachers
- Document type: implementation guide
- Authority level: WHO
- License or terms: CC BY-NC-SA 3.0 IGO
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: medium
- Intended BLESC use: psychoeducation; school safeguarding
- Preferred sections: core interventions; cross-cutting pillars; life skills for young people
- Excluded sections: national budgeting frameworks; situation analysis methodology
- Escalation triggers: not applicable; preventive focus
- Recommended human support: school counselors; public health officials
- Review required by: school counselor
- Refresh frequency: bi-annual

### NICE Guideline NG225: Self-harm assessment, management and preventing recurrence

- Publisher: National Institute for Health and Care Excellence
- Source URL: https://www.nice.org.uk/guidance/ng225
- File URL: https://www.nice.org.uk/guidance/ng225/resources/selfharm-assessment-management-and-preventing-recurrence-pdf-66143830424517
- Publication date: 2022-09-07
- Jurisdiction: UK, globally informative
- Target population: clinicians, administrators
- Document type: guideline
- Authority level: national guideline
- License or terms: Open Government Licence
- Can ingest to Vector Store: yes, with clinical review
- Contains user data: no
- Contains diagnostic criteria: yes
- Clinical risk: high
- Intended BLESC use: crisis escalation; non-diagnostic language
- Preferred sections: principles of care; assessment processes; safeguarding
- Excluded sections: economic modeling; committee discussion
- Escalation triggers: active self-harm; safeguarding concerns for minors
- Recommended human support: mental health professionals; emergency departments
- Review required by: clinician
- Refresh frequency: annual

### SAMHSA 988 Suicide and Crisis Lifeline Suicide Safety Policy and Supplemental Guide

- Publisher: Substance Abuse and Mental Health Services Administration
- Source URL: https://988lifeline.org/professionals/best-practices/
- File URL: https://988lifeline.org/wp-content/uploads/2024/09/988-Suicide-and-Crisis-Lifeline-Suicide-Safety-Policy-2024.pdf
- Publication date: 2024-09-01
- Jurisdiction: United States, globally informative
- Target population: clinicians, administrators
- Document type: hotline resource; guideline
- Authority level: government
- License or terms: public domain for US government material
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: high
- Intended BLESC use: crisis escalation; support resource referral
- Preferred sections: imminent risk criteria; least invasive intervention principles; active engagement strategies
- Excluded sections: administrative reporting requirements for 988 centers
- Escalation triggers: refusal to de-escalate; immediate means; active attempt underway
- Recommended human support: crisis counselor; 988 dispatch; emergency services as last resort
- Review required by: clinician and legal
- Refresh frequency: annual

### Helping Lifeline Callers Who Are at Imminent Risk of Suicide

- Publisher: National Center for Biotechnology Information / PubMed Central
- Source URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC4491352/
- File URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC4491352/pdf/sui-45-60.pdf
- Publication date: 2015-01-01
- Jurisdiction: United States, globally informative
- Target population: clinicians, counselors
- Document type: peer-reviewed psychoeducation and guideline support
- Authority level: academic peer-reviewed
- License or terms: PMC Open Access
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: high
- Intended BLESC use: non-diagnostic language; crisis escalation
- Preferred sections: collaborative problem solving; listening skills; reducing defensiveness
- Excluded sections: research methodology; statistical tables
- Escalation triggers: refusal to collaborate on safety planning
- Recommended human support: crisis counselor
- Review required by: clinician
- Refresh frequency: bi-annual

### Support for Suicidal Individuals on Social and Digital Media

- Publisher: National Suicide Prevention Lifeline / 988
- Source URL: https://988lifeline.org/
- File URL: https://988lifeline.org/wp-content/uploads/2022/07/SupportForSuicidalIndividuals_988.pdf
- Publication date: 2022-07-01
- Jurisdiction: United States, globally informative
- Target population: guardians, minors, students
- Document type: psychoeducation
- Authority level: government-supported crisis resource
- License or terms: public domain for US government material
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: medium
- Intended BLESC use: psychoeducation; support resource referral
- Preferred sections: digital warning signs; reporting suicidal content; reaching out to a friend online
- Excluded sections: platform-specific reporting screens if outdated
- Escalation triggers: direct digital message of imminent harm
- Recommended human support: trusted adult; hotline counselor
- Review required by: school counselor
- Refresh frequency: bi-annual

### CDC Promoting Mental Health and Well-Being in Schools: An Action Guide

- Publisher: Centers for Disease Control and Prevention
- Source URL: https://www.cdc.gov/healthyyouth/mental-health-action-guide/index.html
- File URL: https://www.cdc.gov/mental-health-action-guide/media/pdfs/DASH_MH_Action_Guide_508.pdf
- Publication date: 2023-01-01
- Jurisdiction: United States, school, globally informative
- Target population: administrators, teachers
- Document type: school policy; implementation guide
- Authority level: government
- License or terms: public domain for US government material
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: low
- Intended BLESC use: school safeguarding; psychoeducation
- Preferred sections: school environment strategies; staff well-being; connectedness
- Excluded sections: district-level funding strategies
- Escalation triggers: not applicable; preventive focus
- Recommended human support: school counselor; teacher
- Review required by: school counselor
- Refresh frequency: annual

### WHO Guidelines on mental health promotive and preventive interventions for adolescents

- Publisher: World Health Organization
- Source URL: https://www.who.int/publications/i/item/9789240011854
- File URL: https://www.who.int/docs/default-source/mental-health/guidelines-on-mental-health-promotive-and-preventive-interventions-for-adolescents-hat.pdf
- Publication date: 2020-09-28
- Jurisdiction: global, school
- Target population: administrators, teachers, clinicians
- Document type: guideline
- Authority level: WHO
- License or terms: CC BY-NC-SA 3.0 IGO
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: low
- Intended BLESC use: school safeguarding; psychoeducation
- Preferred sections: psychosocial interventions; universal and targeted prevention; emotional regulation skills
- Excluded sections: GRADE evidence profiles; systematic review methods
- Escalation triggers: not applicable; preventive focus
- Recommended human support: school counselor; teacher
- Review required by: clinician or school counselor
- Refresh frequency: bi-annual

### 厚生労働省 令和5年版 自殺対策白書

- Publisher: 厚生労働省
- Source URL: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/hukushi_kaigo/seikatsuhogo/jisatsu/jisatsuhakusyo_index.html
- File URL: https://www.mhlw.go.jp/content/r5hs-3-1.pdf
- Publication date: 2023-10-01
- Jurisdiction: Japan
- Target population: administrators, teachers, clinicians
- Document type: implementation guide; national guideline
- Authority level: government
- License or terms: Japan government open data
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: medium
- Intended BLESC use: psychoeducation; support resource referral
- Preferred sections: student suicide trends; consultation patterns; warning signs in Japanese context
- Excluded sections: budget allocations; unrelated adult demographics
- Escalation triggers: high absenteeism paired with sudden behavior change
- Recommended human support: スクールカウンセラー; 児童相談所
- Region-specific contacts: こころの健康相談統一ダイヤル 0570-064-556; local consultation links
- Review required by: school counselor and legal
- Refresh frequency: annual

### こども家庭庁 こどもの自殺対策緊急強化プラン

- Publisher: こども家庭庁
- Source URL: https://www.cfa.go.jp/policies/kodomonojisatsutaisaku#plan
- File URL: https://www.cfa.go.jp/policies/kodomonojisatsutaisaku#plan
- Publication date: 2023-06-01
- Last updated: 2024-01-01
- Jurisdiction: Japan, school
- Target population: guardians, teachers, administrators
- Document type: school policy; implementation guide
- Authority level: government
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: medium
- Intended BLESC use: school safeguarding; support resource referral
- Preferred sections: 居場所づくり; SOSの出し方教育; digital safety watch
- Excluded sections: inter-ministerial administrative procedures
- Escalation triggers: digital expression of wanting to disappear
- Recommended human support: trusted adult; school counselor
- Region-specific contacts: チャイルドライン; 24時間子供SOSダイヤル
- Review required by: safeguarding officer
- Refresh frequency: annual

### 文部科学省 児童生徒の自殺予防に関する調査研究協力者会議 報告資料

- Publisher: 文部科学省
- Source URL: https://www.mext.go.jp/a_menu/shotou/seitoshidou/1302907.htm
- File URL: https://www.mext.go.jp/content/20231215-mxt_jidou02-000033077-006.pdf
- Publication date: 2023-12-15
- Jurisdiction: Japan, school
- Target population: students, teachers, guardians
- Document type: school policy; psychoeducation
- Authority level: government
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: medium
- Intended BLESC use: psychoeducation; school safeguarding
- Preferred sections: warning signs for teachers; student device health observation; teacher communication scripts
- Excluded sections: committee member lists; meeting minutes
- Escalation triggers: sudden drop in digital health check scores; chronic absenteeism
- Recommended human support: 担任; 養護教諭; スクールカウンセラー
- Region-specific contacts: 24時間子供SOSダイヤル 0120-0-78310
- Review required by: school counselor
- Refresh frequency: annual

### SAMHSA Concept of Trauma and Guidance for a Trauma-Informed Approach

- Publisher: Substance Abuse and Mental Health Services Administration
- Source URL: https://store.samhsa.gov/product/samhsas-concept-trauma-and-guidance-trauma-informed-approach/sma14-4884
- File URL: https://www.health.ny.gov/health_care/medicaid/program/medicaid_health_homes/docs/samhsa_trauma_concept_paper.pdf
- Publication date: 2014-07-01
- Jurisdiction: United States, globally informative
- Target population: clinicians, administrators, teachers
- Document type: guideline; psychoeducation
- Authority level: government
- Can ingest to Vector Store: yes
- Contains user data: no
- Contains diagnostic criteria: no
- Clinical risk: low
- Intended BLESC use: non-diagnostic language; psychoeducation
- Preferred sections: safety; trustworthiness; peer support; collaboration; empowerment; cultural issues; shifting from blame to context
- Excluded sections: historical development of the task force
- Escalation triggers: not applicable; interaction framework
- Recommended human support: trauma-informed clinician or counselor
- Review required by: clinician
- Refresh frequency: bi-annual
