---
license: cc-by-nc-4.0
configs:
- config_name: default
  data_files:
  - split: train
    path: "sample.parquet"
dataset_info:
  features:
  - name: TASK_ID
    dtype: string
  - name: BATCH
    dtype: string
  - name: SUBJECT
    dtype: string
  - name: PROMPT
    dtype: string
  - name: IMAGE_URL
    dtype: string
  - name: UC1_INITIAL_EXPLANATION
    dtype: string
  - name: FOLLOW_UP_PROMPT
    dtype: string
  - name: RUBRICS
    dtype: string
  - name: bloom_taxonomy
    dtype: string
  - name: Image
    dtype: image
  splits:
  - name: train
    num_bytes: 12547880
    num_examples: 30
  download_size: 12419656
  dataset_size: 12547880
language:
- en
tags:
- tutoring
pretty_name: AI tutor
size_categories:
- n<1K
---
# TutorBench Dataset Sample

## Overview

TutorBench_sample.csv is a subset of the TutorBench dataset, which contains educational tutoring scenarios designed to evaluate AI tutoring systems. This sample dataset consists of **30 samples** across three use cases (adaptive explanation generation (USE_CASE_1), assessment and feedback (USE_CASE_2), and active learning support (USE_CASE_3)).

## Dataset Structure

The dataset contains **9 columns** with the following structure:

| Column | Description |
|--------|-------------|
| `TASK_ID` | Unique identifier for each tutoring task (32-character hexadecimal string) |
| `BATCH` | Use case classification | 
| `SUBJECT` | Academic subject area of the problem |
| `PROMPT` | Initial question or problem statement presented to the AI tutor |
| `IMAGE_URL` | URL link to associated visual content (for multimodal tasks) |
| `UC1_INITIAL_EXPLANATION` | Detailed initial explanation/solution provided by the tutor (for the adaptive explanation use case)|
| `FOLLOW_UP_PROMPT` | Student's follow-up question or expression of confusion (contains student solution for the 'assessment and feedback', and 'active learning support' use cases ) |
| `RUBRICS` | Detailed evaluation criteria in JSON format for assessing tutor responses along with category tags |
| `bloom_taxonomy` | Bloom's taxonomy classification (e.g., "Apply", "Analyze") |

## Subject Distribution

The dataset covers **6 academic subjects** with the following distribution:

- **Chemistry**
- **Calculus**
- **Computer Science**
- **Biology**
- **Statistics**
- **Physics**



## Related Files

This sample dataset is part of the larger TutorBench collection which includes:
- 1,490 samples
- 15,220 rubric criteria across all samples