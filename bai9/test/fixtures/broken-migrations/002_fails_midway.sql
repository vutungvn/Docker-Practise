-- The first two statements succeed, the third fails: nothing from this file may survive.
CREATE TABLE half_done (id INTEGER NOT NULL);
INSERT INTO half_done VALUES (1);
INSERT INTO half_done VALUES ('not-a-number');
