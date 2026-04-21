create database laesfera;
use laesfera;
-- 1. Users table
CREATE TABLE IF NOT EXISTS userss (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Snippets table
CREATE TABLE IF NOT EXISTS snippets (
    id INT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    language VARCHAR(50) NOT NULL,
    tags JSON DEFAULT NULL,                 -- stores array of tags as JSON
    code TEXT NOT NULL,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES userss(id) ON DELETE SET NULL
);

-- 3. Comments table
CREATE TABLE IF NOT EXISTS comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    snippet_id INT NOT NULL,
    line_number INT NOT NULL,
    user_id INT,
    username VARCHAR(100) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (snippet_id) REFERENCES snippets(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES userss(id) ON DELETE SET NULL
);

select * from userss;
select * from snippets;
select * from comments;


CREATE DATABASE laesfera;
CREATE USER 'codecollab2'@'localhost' IDENTIFIED BY 'secure2password';
GRANT ALL PRIVILEGES ON laesfera.* TO 'codecollab2'@'localhost';
FLUSH PRIVILEGES;