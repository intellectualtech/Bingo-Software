CREATE DATABASE IF NOT EXISTS bingo;
USE bingo;

-- Table for users (admin, cashier, display)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'cashier', 'display') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_username (username)
);

-- Table for tickets
CREATE TABLE IF NOT EXISTS tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  game_id VARCHAR(10) NOT NULL,
  player_name VARCHAR(100) NOT NULL,
  ticket_price DECIMAL(10, 2) NOT NULL,
  lucky_numbers JSON NOT NULL,
  slip_number VARCHAR(20) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_game_id (game_id),
  INDEX idx_slip_number (slip_number)
);

-- Table for current game state
CREATE TABLE IF NOT EXISTS games (
  id INT AUTO_INCREMENT PRIMARY KEY,
  game_id VARCHAR(10) NOT NULL UNIQUE,
  available_balls JSON NOT NULL,
  drawn_balls JSON NOT NULL,
  bonus_ball INT DEFAULT NULL,
  winner JSON DEFAULT NULL,
  is_running BOOLEAN NOT NULL DEFAULT FALSE,
  is_counting_down BOOLEAN NOT NULL DEFAULT FALSE,
  draw_start_time TIMESTAMP NULL,
  draw_end_time TIMESTAMP NULL,
  last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_game_id (game_id)
);

-- Table for game history
CREATE TABLE IF NOT EXISTS game_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  game_id VARCHAR(10) NOT NULL,
  slip_number VARCHAR(20) DEFAULT NULL,
  prize DECIMAL(10, 2) DEFAULT NULL,
  drawn_balls JSON NOT NULL,
  bonus_ball INT DEFAULT NULL,
  winner JSON DEFAULT NULL,
  completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_game_id (game_id),
  INDEX idx_slip_number (slip_number)
);

-- Table for cashiers
CREATE TABLE IF NOT EXISTS cashiers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  location_id INT DEFAULT NULL,
  display_id INT DEFAULT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  activity_log JSON DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_name (name)
);

-- Table for screens
CREATE TABLE IF NOT EXISTS screens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  location_id INT DEFAULT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_name (name)
);

-- Updated table for earnings with collected and collected_at columns
CREATE TABLE IF NOT EXISTS earnings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  game_id VARCHAR(10) NOT NULL,
  slip_number VARCHAR(20) NOT NULL,
  player_name VARCHAR(100) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  earned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  collected BOOLEAN NOT NULL DEFAULT FALSE,
  collected_at TIMESTAMP NULL,
  INDEX idx_game_id (game_id),
  INDEX idx_slip_number (slip_number),
  INDEX idx_collected (collected)
);

-- New table for earnings collections
CREATE TABLE IF NOT EXISTS earnings_collections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  amount DECIMAL(10, 2) NOT NULL,
  collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  collected_by VARCHAR(50) NOT NULL,
  INDEX idx_collected_at (collected_at)
);

-- Insert default users
INSERT IGNORE INTO users (username, password, role) VALUES
('admin', 'admin123', 'admin'),
('cashier', 'cashier123', 'cashier'),
('display', 'display123', 'display');


-- Creating table for locations
CREATE TABLE IF NOT EXISTS locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT NOT NULL,
  max_win DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE games ADD COLUMN location_id INT;
ALTER TABLE tickets ADD COLUMN location_id INT;
ALTER TABLE earnings ADD COLUMN location_id INT;
ALTER TABLE game_history ADD COLUMN location_id INT;



//demo DATABASE


USE bingo;

-- Insert demo locations
INSERT INTO locations (name, address, max_win) VALUES
('Windhoek Central', '123 Main Street, Windhoek, Namibia', 5000.00),
('Swakopmund Branch', '456 Ocean Road, Swakopmund, Namibia', 3000.00);

-- Insert demo users with location_id
INSERT IGNORE INTO users (username, password, role, location_id) VALUES
('admin1', 'adminpass123', 'admin', NULL), -- Admin (no location)
('cashier1', 'cashierpass1', 'cashier', 1), -- Cashier for Windhoek
('cashier2', 'cashierpass2', 'cashier', 2), -- Cashier for Swakopmund
('display1', 'displaypass1', 'display', 1), -- Display for Windhoek
('display2', 'displaypass2', 'display', 2); -- Display for Swakopmund

-- Insert demo cashiers
INSERT INTO cashiers (name, location_id, display_id, status, activity_log) VALUES
('John Doe', 1, 1, 'active', '["Initial setup on 2025-07-19"]'),
('Jane Smith', 2, 2, 'active', '["Initial setup on 2025-07-19"]');

-- Insert demo screens
INSERT INTO screens (name, location_id, status) VALUES
('Windhoek Screen 1', 1, 'active'),
('Swakopmund Screen 1', 2, 'active');

-- Insert demo games (one active game per location)
INSERT INTO games (game_id, available_balls, drawn_balls, is_running, is_counting_down, draw_start_time, draw_end_time, location_id) VALUES
('BG-ABC12-1', '["3","4","6","8","10","12","14","16","18","20","22","24","26","28","30","32","34","36","38","40","42","44","46","48"]', '["1","2","5","7","9","11","13","15","17","19"]', TRUE, FALSE, '2025-07-19 07:00:00', '2025-07-19 07:05:00', 1),
('BG-DEF34-2', '["2","4","6","8","10","12","14","16","18","20","22","24","26","28","30","32","34","36","38","40","42","44","46","48"]', '["1","3","5","7","9","11","13","15","17","19"]', TRUE, FALSE, '2025-07-19 07:10:00', '2025-07-19 07:15:00', 2);

-- Insert demo tickets
INSERT INTO tickets (game_id, player_name, ticket_price, lucky_numbers, slip_number, location_id) VALUES
('BG-ABC12-1', 'Alice Johnson', 50.00, '[["1","5","10","15","20","25"]]', 'ML-XYZ123-1721455200000', 1),
('BG-ABC12-1', 'Bob Williams', 30.00, '[["2","7","12","17","22","27"]]', 'ML-XYZ124-1721455201000', 1),
('BG-DEF34-2', 'Charlie Brown', 40.00, '[["3","8","13","18","23","28"]]', 'ML-XYZ125-1721455202000', 2),
('BG-DEF34-2', 'Diana Evans', 60.00, '[["1","6","11","16","21","26"]]', 'ML-XYZ126-1721455203000', 2);

-- Insert demo earnings
INSERT INTO earnings (game_id, slip_number, player_name, amount, earned_at, collected, collected_at, location_id) VALUES
('BG-ABC12-1', 'ML-XYZ123-1721455200000', 'Alice Johnson', 100.00, '2025-07-19 07:20:00', FALSE, NULL, 1),
('BG-ABC12-1', 'ML-XYZ124-1721455201000', 'Bob Williams', 50.00, '2025-07-19 07:25:00', TRUE, '2025-07-19 07:30:00', 1),
('BG-DEF34-2', 'ML-XYZ125-1721455202000', 'Charlie Brown', 75.00, '2025-07-19 07:22:00', FALSE, NULL, 2),
('BG-DEF34-2', 'ML-XYZ126-1721455203000', 'Diana Evans', 120.00, '2025-07-19 07:27:00', FALSE, NULL, 2);

-- Insert demo game history
INSERT INTO game_history (game_id, slip_number, prize, drawn_balls, bonus_ball, winner, completed_at, location_id) VALUES
('BG-OLD56-1', 'ML-XYZ100-1721378800000', 500.00, '["1","5","10","15","20","25","30","35","40"]', 45, '{"player":"Alice Johnson","prize":500}', '2025-07-18 12:00:00', 1),
('BG-OLD78-2', 'ML-XYZ101-1721378801000', 300.00, '["3","8","13","18","23","28","33","38","43"]', 47, '{"player":"Charlie Brown","prize":300}', '2025-07-18 12:30:00', 2);

-- Insert demo earnings collections
INSERT INTO earnings_collections (amount, collected_at, collected_by, location_id) VALUES
(150.00, '2025-07-19 07:30:00', 'admin1', 1),
(200.00, '2025-07-19 07:35:00', 'admin1', 2);


-- Add missing columns/tables for admin dashboard features (use IF NOT EXISTS for CREATE, but ALTER must be in a DELIMITER block for MariaDB/MySQL)


DELIMITER $$

-- Add location_id to users if not present
CREATE PROCEDURE add_location_id_to_users()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'location_id'
  ) THEN
    ALTER TABLE users ADD COLUMN location_id INT DEFAULT NULL;
  END IF;
END$$

-- Add status to users if not present
CREATE PROCEDURE add_status_to_users()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'status'
  ) THEN
    ALTER TABLE users ADD COLUMN status ENUM('active','inactive') DEFAULT 'active';
  END IF;
END$$

-- Add status to cashiers if not present
CREATE PROCEDURE add_status_to_cashiers()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'cashiers' AND column_name = 'status'
  ) THEN
    ALTER TABLE cashiers ADD COLUMN status ENUM('active','inactive') DEFAULT 'active';
  END IF;
END$$

-- Add activity_log to cashiers if not present
CREATE PROCEDURE add_activity_log_to_cashiers()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'cashiers' AND column_name = 'activity_log'
  ) THEN
    ALTER TABLE cashiers ADD COLUMN activity_log JSON DEFAULT NULL;
  END IF;
END$$

-- Add status to screens if not present
CREATE PROCEDURE add_status_to_screens()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'screens' AND column_name = 'status'
  ) THEN
    ALTER TABLE screens ADD COLUMN status ENUM('active','inactive') DEFAULT 'active';
  END IF;
END$$

-- Add created_at to locations if not present
CREATE PROCEDURE add_created_at_to_locations()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'locations' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE locations ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  END IF;
END$$

-- Add max_win to locations if not present
CREATE PROCEDURE add_max_win_to_locations()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'locations' AND column_name = 'max_win'
  ) THEN
    ALTER TABLE locations ADD COLUMN max_win DECIMAL(10,2) DEFAULT 0;
  END IF;
END$$

-- Add location_id to games if not present
CREATE PROCEDURE add_location_id_to_games()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'games' AND column_name = 'location_id'
  ) THEN
    ALTER TABLE games ADD COLUMN location_id INT DEFAULT NULL;
  END IF;
END$$

-- Add location_id to tickets if not present
CREATE PROCEDURE add_location_id_to_tickets()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'location_id'
  ) THEN
    ALTER TABLE tickets ADD COLUMN location_id INT DEFAULT NULL;
  END IF;
END$$

-- Add location_id to earnings if not present
CREATE PROCEDURE add_location_id_to_earnings()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'earnings' AND column_name = 'location_id'
  ) THEN
    ALTER TABLE earnings ADD COLUMN location_id INT DEFAULT NULL;
  END IF;
END$$

-- Add location_id to game_history if not present
CREATE PROCEDURE add_location_id_to_game_history()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'game_history' AND column_name = 'location_id'
  ) THEN
    ALTER TABLE game_history ADD COLUMN location_id INT DEFAULT NULL;
  END IF;
END$$

-- Add collected and collected_at to earnings if not present
CREATE PROCEDURE add_collected_to_earnings()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'earnings' AND column_name = 'collected'
  ) THEN
    ALTER TABLE earnings ADD COLUMN collected BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'earnings' AND column_name = 'collected_at'
  ) THEN
    ALTER TABLE earnings ADD COLUMN collected_at TIMESTAMP NULL;
  END IF;
END$$

-- Add winners JSON to reports if not present
CREATE PROCEDURE add_winners_to_reports()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'reports' AND column_name = 'winners'
  ) THEN
    ALTER TABLE reports ADD COLUMN winners JSON;
  END IF;
END$$

-- Add total_tickets to reports if not present
CREATE PROCEDURE add_total_tickets_to_reports()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'reports' AND column_name = 'total_tickets'
  ) THEN
    ALTER TABLE reports ADD COLUMN total_tickets INT DEFAULT 0;
  END IF;
END$$

-- Add date to reports if not present
CREATE PROCEDURE add_date_to_reports()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'reports' AND column_name = 'date'
  ) THEN
    ALTER TABLE reports ADD COLUMN date DATETIME DEFAULT CURRENT_TIMESTAMP;
  END IF;
END$$

-- Add location_id to earnings_collections if not present
CREATE PROCEDURE add_location_id_to_earnings_collections()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'earnings_collections' AND column_name = 'location_id'
  ) THEN
    ALTER TABLE earnings_collections ADD COLUMN location_id INT DEFAULT NULL;
  END IF;
END$$

DELIMITER ;

-- Call all procedures to apply changes
CALL add_location_id_to_users();
CALL add_status_to_users();
CALL add_status_to_cashiers();
CALL add_activity_log_to_cashiers();
CALL add_status_to_screens();
CALL add_created_at_to_locations();
CALL add_max_win_to_locations();
CALL add_location_id_to_games();
CALL add_location_id_to_tickets();
CALL add_location_id_to_earnings();
CALL add_location_id_to_game_history();
CALL add_collected_to_earnings();
CALL add_winners_to_reports();
CALL add_total_tickets_to_reports();
CALL add_date_to_reports();
CALL add_location_id_to_earnings_collections();

-- Drop procedures after use (optional, keeps schema clean)
DROP PROCEDURE IF EXISTS add_location_id_to_users;
DROP PROCEDURE IF EXISTS add_status_to_users;
DROP PROCEDURE IF EXISTS add_status_to_cashiers;
DROP PROCEDURE IF EXISTS add_activity_log_to_cashiers;
DROP PROCEDURE IF EXISTS add_status_to_screens;
DROP PROCEDURE IF EXISTS add_created_at_to_locations;
DROP PROCEDURE IF EXISTS add_max_win_to_locations;
DROP PROCEDURE IF EXISTS add_location_id_to_games;
DROP PROCEDURE IF EXISTS add_location_id_to_tickets;
DROP PROCEDURE IF EXISTS add_location_id_to_earnings;
DROP PROCEDURE IF EXISTS add_location_id_to_game_history;
DROP PROCEDURE IF EXISTS add_collected_to_earnings;
DROP PROCEDURE IF EXISTS add_winners_to_reports;
DROP PROCEDURE IF EXISTS add_total_tickets_to_reports;
DROP PROCEDURE IF EXISTS add_date_to_reports;
DROP PROCEDURE IF EXISTS add_location_id_to_earnings_collections;

-- Add jackpots table if not present
CREATE TABLE IF NOT EXISTS jackpots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  location_id INT,
  bronze DECIMAL(10, 2),
  silver DECIMAL(10, 2),
  gold DECIMAL(10, 2),
  max DECIMAL(10, 2),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

-- Add reports table if not present
CREATE TABLE IF NOT EXISTS reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(255) NOT NULL,
  total_revenue DECIMAL(10, 2) NOT NULL,
  total_tickets INT DEFAULT 0,
  winners JSON,
  date DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add error_logs table for admin error log viewing (optional, for persistent logs)
CREATE TABLE IF NOT EXISTS error_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message TEXT NOT NULL,
  stack TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);





--demo data

USE bingo;

-- Insert demo data for jackpots
INSERT INTO jackpots (location_id, bronze, silver, gold, max) VALUES
(1, 2000.00, 5000.00, 10000.00, 20000.00),
(2, 1500.00, 4000.00, 8000.00, 15000.00);

-- Insert demo data for game_config
INSERT INTO game_config (draw_interval, bonus_ball_enabled, auto_draw) VALUES
(300, TRUE, TRUE), -- 5-minute draw interval, bonus ball enabled, auto-draw enabled
(600, FALSE, FALSE); -- 10-minute draw interval, bonus ball disabled, auto-draw disabled

-- Insert demo data for reports
INSERT INTO reports (type, total_revenue, total_tickets, winners, date) VALUES
('Daily Income', 1250.00, 25, '[{"player":"Alice Johnson","amount":500},{"player":"Bob Williams","amount":250}]', '2025-07-19 23:59:59'),
('Weekly Win Tickets', 3200.00, 60, '[{"player":"Charlie Brown","amount":300},{"player":"Diana Evans","amount":400}]', '2025-07-18 23:59:59');

-- Insert demo data for notifications
INSERT INTO notifications (message, target, date) VALUES
('Game BG-ABC12-1 is starting soon at Windhoek Central', 'all', '2025-07-19 06:50:00'),
('Maintenance scheduled for Swakopmund Branch', 'cashier2', '2025-07-20 08:00:00'),
('Jackpot tier updated for Windhoek Central', 'admin1', '2025-07-19 09:00:00');

-- Insert demo data for error_logs
INSERT INTO error_logs (message, stack, created_at, location_id, cashier_id) VALUES
('Failed to draw ball due to connection timeout', 'Error: Connection timeout at drawBall.js:45', '2025-07-19 07:15:00', 1, 1),
('Invalid ticket number entered', 'Error: Validation failed at ticketValidation.js:23', '2025-07-19 08:00:00', 2, 2),
('Database query failed for earnings collection', 'Error: Query error at earningsCollection.js:67', '2025-07-19 09:30:00', 1, NULL);

-- Update cashiers with username and password if not already set
UPDATE cashiers SET username = 'john_doe', password = 'password123' WHERE id = 1;
UPDATE cashiers SET username = 'jane_smith', password = 'password456' WHERE id = 2;