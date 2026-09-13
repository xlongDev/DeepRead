//! Learning cards (Sprint 12): flashcards, quiz items and mistakes with
//! SM-2-lite state on the row.
//!
//! The scheduling math lives in `@deepread/shared` (`srs.ts`) and is
//! unit-tested there; Rust is a dumb, safe store — it persists rows and
//! applies the review fields the frontend computed. Nothing else.

use rusqlite::Connection;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};

pub const CARD_SOURCES: &[&str] = &["highlight", "quiz", "mistake"];
const MAX_CARDS_PER_ADD: usize = 200;

fn validate_source(source: &str) -> Result<(), AppError> {
    if CARD_SOURCES.contains(&source) {
        Ok(())
    } else {
        Err(AppError::new(ErrorCode::SystemValidation, "未知的卡片来源")
            .with_context("source", serde_json::Value::String(source.to_string())))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub id: String,
    pub book_hash: String,
    pub front: String,
    pub back: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfi: Option<String>,
    pub ease: f64,
    pub interval_days: f64,
    pub reps: i64,
    pub lapses: i64,
    pub due_at: String,
    pub created_at: String,
}

const CARD_COLUMNS: &str = "id, book_hash, front, back, source, cfi, ease, interval_days, reps, lapses, due_at, created_at";

fn row_to_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<CardRow> {
    Ok(CardRow {
        id: row.get(0)?,
        book_hash: row.get(1)?,
        front: row.get(2)?,
        back: row.get(3)?,
        source: row.get(4)?,
        cfi: row.get(5)?,
        ease: row.get(6)?,
        interval_days: row.get(7)?,
        reps: row.get(8)?,
        lapses: row.get(9)?,
        due_at: row.get(10)?,
        created_at: row.get(11)?,
    })
}

pub fn list_cards(conn: &Connection, book_hash: Option<&str>) -> Result<Vec<CardRow>, AppError> {
    let query_cards = |sql: &str, params: &[&str]| -> Result<Vec<CardRow>, AppError> {
        let mut statement = conn.prepare(sql).map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to query cards").with_cause(err)
        })?;
        let rows = statement
            .query_map(params_from_iter(params.iter()), row_to_card)
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to read cards").with_cause(err)
            })?;
        Ok(rows.filter_map(Result::ok).collect())
    };
    match book_hash {
        Some(hash) => {
            crate::state::validate_hash(hash)?;
            query_cards(
                &format!("SELECT {CARD_COLUMNS} FROM cards WHERE book_hash = ?1 ORDER BY due_at"),
                &[hash],
            )
        }
        None => query_cards(
            &format!("SELECT {CARD_COLUMNS} FROM cards ORDER BY due_at"),
            &[],
        ),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewCard {
    pub id: String,
    pub front: String,
    pub back: String,
    pub source: String,
    #[serde(default)]
    pub cfi: Option<String>,
    pub due_at: String,
}

/// Insert-or-ignore each card: regenerating from the same highlights never
/// resets review progress. Returns how many rows were actually added.
pub fn add_cards(conn: &Connection, book_hash: &str, cards: &[NewCard]) -> Result<usize, AppError> {
    crate::state::validate_hash(book_hash)?;
    if cards.len() > MAX_CARDS_PER_ADD {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "一次添加的卡片过多",
        ));
    }
    let mut added = 0;
    for card in cards {
        validate_source(&card.source)?;
        added += conn
            .execute(
                "INSERT OR IGNORE INTO cards (id, book_hash, front, back, source, cfi, due_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    card.id,
                    book_hash,
                    card.front,
                    card.back,
                    card.source,
                    card.cfi,
                    card.due_at,
                    crate::timestamps::rfc3339_now(),
                ],
            )
            .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save card").with_cause(err))?;
    }
    Ok(added)
}

pub fn remove_card(conn: &Connection, id: &str) -> Result<bool, AppError> {
    let removed = conn
        .execute("DELETE FROM cards WHERE id = ?1", [id])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to remove card").with_cause(err)
        })?;
    Ok(removed > 0)
}

/// Apply the review state the frontend scheduled for this card.
pub fn review_card(
    conn: &Connection,
    id: &str,
    ease: f64,
    interval_days: f64,
    reps: i64,
    lapses: i64,
    due_at: &str,
) -> Result<bool, AppError> {
    let updated = conn
        .execute(
            "UPDATE cards SET ease = ?2, interval_days = ?3, reps = ?4, lapses = ?5, due_at = ?6
             WHERE id = ?1",
            rusqlite::params![id, ease, interval_days, reps, lapses, due_at],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to review card").with_cause(err)
        })?;
    Ok(updated > 0)
}

// ---------- IPC wrappers ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardsListRequest {
    #[serde(default)]
    pub book_hash: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardsListResponse {
    pub cards: Vec<CardRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardsAddRequest {
    pub book_hash: String,
    pub cards: Vec<NewCard>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardsAddResponse {
    pub added: usize,
    pub saved_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardsRemoveRequest {
    pub id: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardsRemoveResponse {
    pub removed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardsReviewRequest {
    pub id: String,
    pub ease: f64,
    pub interval_days: f64,
    pub reps: i64,
    pub lapses: i64,
    pub due_at: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardsReviewResponse {
    pub due_at: String,
}

#[tauri::command(rename = "cards.list")]
pub fn cards_list(
    db: tauri::State<'_, crate::storage::Db>,
    request: CardsListRequest,
) -> Result<CardsListResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(CardsListResponse {
        cards: list_cards(&conn, request.book_hash.as_deref())?,
    })
}

#[tauri::command(rename = "cards.add")]
pub fn cards_add(
    db: tauri::State<'_, crate::storage::Db>,
    request: CardsAddRequest,
) -> Result<CardsAddResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let added = add_cards(&conn, &request.book_hash, &request.cards)?;
    Ok(CardsAddResponse {
        added,
        saved_at: crate::timestamps::rfc3339_now(),
    })
}

#[tauri::command(rename = "cards.remove")]
pub fn cards_remove(
    db: tauri::State<'_, crate::storage::Db>,
    request: CardsRemoveRequest,
) -> Result<CardsRemoveResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(CardsRemoveResponse {
        removed: remove_card(&conn, &request.id)?,
    })
}

#[tauri::command(rename = "cards.review")]
pub fn cards_review(
    db: tauri::State<'_, crate::storage::Db>,
    request: CardsReviewRequest,
) -> Result<CardsReviewResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let updated = review_card(
        &conn,
        &request.id,
        request.ease,
        request.interval_days,
        request.reps,
        request.lapses,
        &request.due_at,
    )?;
    if !updated {
        return Err(AppError::new(ErrorCode::SystemValidation, "卡片不存在"));
    }
    Ok(CardsReviewResponse {
        due_at: request.due_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::storage::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (hash, file_name, format, path, size, added_at) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'n', 'epub', '/p', 1, 't')",
            [],
        )
        .unwrap();
        conn
    }

    fn sample(id: &str) -> NewCard {
        NewCard {
            id: id.into(),
            front: "问:主角为何离开?".into(),
            back: "为了寻找答案。".into(),
            source: "highlight".into(),
            cfi: None,
            due_at: "2026-09-14T00:00:00Z".into(),
        }
    }

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn cards_round_trip_and_ignore_duplicates() {
        let conn = memory_db();
        assert_eq!(
            add_cards(&conn, HASH, &[sample("card-1"), sample("card-2")]).unwrap(),
            2
        );
        // Re-adding keeps review progress, adds nothing.
        assert_eq!(add_cards(&conn, HASH, &[sample("card-1")]).unwrap(), 0);
        let cards = list_cards(&conn, Some(HASH)).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].id, "card-1");
        assert_eq!(list_cards(&conn, None).unwrap().len(), 2);
    }

    #[test]
    fn review_updates_srs_fields() {
        let conn = memory_db();
        add_cards(&conn, HASH, &[sample("card-1")]).unwrap();
        assert!(review_card(&conn, "card-1", 2.3, 1.0, 1, 0, "2026-09-15T00:00:00Z").unwrap());
        let card = &list_cards(&conn, Some(HASH)).unwrap()[0];
        assert_eq!(card.ease, 2.3);
        assert_eq!(card.reps, 1);
        assert_eq!(card.due_at, "2026-09-15T00:00:00Z");
        assert!(!review_card(&conn, "missing-card", 2.5, 0.0, 0, 0, "t").unwrap());
    }

    #[test]
    fn remove_and_validation_guards() {
        let conn = memory_db();
        add_cards(&conn, HASH, &[sample("card-1")]).unwrap();
        assert!(remove_card(&conn, "card-1").unwrap());
        assert!(!remove_card(&conn, "card-1").unwrap());
        let mut bad = sample("card-x");
        bad.source = "evil".into();
        assert!(add_cards(&conn, HASH, &[bad]).is_err());
        assert!(add_cards(&conn, "../evil", &[sample("card-x")]).is_err());
    }
}
