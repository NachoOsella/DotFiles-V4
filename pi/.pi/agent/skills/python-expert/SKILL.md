---
name: python-expert
description: "Advanced Python development (3.10+) focusing on FastAPI, Pydantic v2, and Data Science. Use when you need to: (1) build APIs with FastAPI, (2) implement data validation with Pydantic, (3) write async applications, (4) create data pipelines with Pandas/Polars, (5) implement ML models, or (6) build CLI tools with Typer/Click."
---

# Python Development

## API Development (FastAPI)

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    name: str
    price: float

@app.post("/items/")
async def create_item(item: Item) -> Item:
    return item
```

## Data Validation (Pydantic v2)

```python
from pydantic import BaseModel, Field, field_validator

class User(BaseModel):
    name: str = Field(min_length=1)
    email: str
    
    @field_validator('email')
    @classmethod
    def validate_email(cls, v: str) -> str:
        if '@' not in v:
            raise ValueError('Invalid email')
        return v
```

## Async Patterns

```python
import asyncio

async def fetch_all(urls: list[str]) -> list[str]:
    async with aiohttp.ClientSession() as session:
        tasks = [fetch(session, url) for url in urls]
        return await asyncio.gather(*tasks)
```

## Data Science

```python
import pandas as pd
import polars as pl

# Pandas
df = pd.read_csv('data.csv')
result = df.groupby('category')['value'].mean()

# Polars (faster)
df = pl.read_csv('data.csv')
result = df.group_by('category').agg(pl.col('value').mean())
```

## Guidelines

- Use type hints everywhere (PEP 484)
- Prefer `ruff` for linting/formatting
- Use context managers for resource management
- Prefer `uv` or `poetry` for dependency management
