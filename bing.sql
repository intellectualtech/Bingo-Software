-- Creating the bingo database
CREATE DATABASE IF NOT EXISTS bingo;
USE bingo;

-- Table for users (admin, cashier, display)
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'cashier', 'display') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_username (username)
);

-- Table for tickets
CREATE TABLE tickets (
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
CREATE TABLE games (
  id INT AUTO_INCREMENT PRIMARY KEY,
  game_id VARCHAR(10) NOT NULL UNIQUE,
  available_balls JSON NOT NULL,
  drawn_balls JSON NOT NULL,
  bonus_ball INT DEFAULT NULL,
  winner VARCHAR(100) DEFAULT NULL,
  is_running BOOLEAN NOT NULL DEFAULT FALSE,
  is_counting_down BOOLEAN NOT NULL DEFAULT FALSE,
  last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_game_id (game_id)
);

-- Table for game history
CREATE TABLE game_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  game_id VARCHAR(10) NOT NULL,
  drawn_balls JSON NOT NULL,
  bonus_ball INT DEFAULT NULL,
  winner VARCHAR(100) DEFAULT NULL,
  completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_game_id (game_id)
);

-- Insert default users
INSERT INTO users (username, password, role) VALUES
('admin', 'admin123', 'admin'),
('cashier', 'cashier123', 'cashier'),
('display', 'display123', 'display');