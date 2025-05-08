const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const randomUseragent = require('random-useragent');
const axios = require("axios");
const path = require('path');
const cron = require('node-cron');
const mysql = require('mysql2/promise');
const fs = require('fs');
const { parse } = require('json2csv');
const moment = require('moment-timezone');
const express = require('express');
const cors = require('cors');
const app = express();
const http = require('http');
app.use(cors());
require("dotenv").config();
const nodemailer = require("nodemailer");

const dbConfig = {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB,
};


const uploadDir = path.join(__dirname, 'upload');

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'charts.html'));
});
app.get('/table', (req, res) => {
    res.sendFile(path.join(__dirname, 'table.html'));
});

puppeteer.use(StealthPlugin());

const ScrapData = async (url, retriesLeft = 5) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false, // Set to true for production
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ],
            timeout: 120000
        });

        const page = await browser.newPage();

        // Use a random User-Agent
        const userAgent = randomUseragent.getRandom();
        await page.setUserAgent(userAgent);

        // Set extra headers to mimic real browser behavior
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1'
        });

        // Load cookies if available
        const cookiesFilePath = path.join(__dirname, 'cookies.json');
        if (fs.existsSync(cookiesFilePath)) {
            const cookies = JSON.parse(fs.readFileSync(cookiesFilePath, 'utf8'));
            await page.setCookie(...cookies);
        } else {
            console.warn('Cookies file not found. Proceeding without setting cookies.');
        }

        // Function to attempt scraping
        const attemptScraping = async () => {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });

                // Scroll down to simulate user behavior
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForSelector('.live-info', { visible: true, timeout: 30000 });

                // Extract table data
                const rowsData = await page.evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('tr'));
                    let filteredRows = [];

                    rows.forEach((row, index) => {
                        const classAttr = row.getAttribute('class');
                        if (index === 1 || (classAttr && classAttr.includes('live-cash-game aside-activity-item'))) {
                            // Remove last header and last cell if present
                            row.querySelectorAll('th:last-child, td:last-child').forEach(el => el.remove());

                            // Extract text from table cells
                            const rowData = Array.from(row.querySelectorAll('td')).map(cell => cell.textContent.trim());
                            filteredRows.push(rowData);
                        }
                    });

                    return filteredRows;
                });

                // Save updated cookies
                const newCookies = await page.cookies();
                fs.writeFileSync(cookiesFilePath, JSON.stringify(newCookies));

                return rowsData;
            } catch (error) {
                throw error;
            }
        };

        return await attemptScraping();
    } catch (error) {
        console.error('Error during scraping:', error);

        if (retriesLeft > 0 && error.name === 'TimeoutError') {
            console.warn(`Timeout occurred. Relaunching browser... (${retriesLeft} retries left)`);
            return await ScrapData(url, retriesLeft - 1); // Relaunch Puppeteer & retry
        }else{
            const failureTime = moment().tz("America/Chicago").format("YYYY-MM-DD hh:mm A z");
            const data = `Scraping failed for URL: ${url} after multiple retries.\nFailure Time: ${failureTime}`
            await sendFailureEmail(data);
        }

        return [];
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};
const sendFailureEmail = async (param) => {
    try {
        const failureTime = moment().tz("America/Chicago").format("YYYY-MM-DD hh:mm A z");
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: "felixxavierdhas@gmail.com",
                pass: "voik uiqh bfai akmt", 
            },
        });

        const mailOptions = {
            from: "felixxavierdhas@gmail.com",
            to: "mvenkateshsmart@gmail.com",
            subject: "EPL ANALYTICS: Alert",
            text: `${param}`,
        };

        await transporter.sendMail(mailOptions);

        console.log(`Failure notification email sent at ${failureTime}`);
    } catch (emailError) {
        console.error("Error sending email:", emailError);
    }
};



async function openUrl(url, tableName) {
    let connection;
    try {
        const rowsData = await ScrapData(url);
        connection = await mysql.createConnection(dbConfig);
        for (const row of rowsData) {
            if (row.length >= 3) {
                const gameName = row[0];
                const tables = parseInt(row[1], 10); 
                const waiting = parseInt(row[2], 10);
                const timestamp = moment().tz('America/Chicago').format('YYYY-MM-DD HH:mm:ss');
                
                const query = `INSERT INTO ${tableName} (game_name, tables, waiting, timestamp) VALUES (?, ?, ?, ?)`;

                try {
                    await connection.execute(query, [gameName, tables, waiting, timestamp]);
                } catch (err) {
                    console.error("SQL Error:", err.message);
                }
            }
        }

    } catch (error) {
        console.error("Error:", error.message);
    }
    finally{
        if (connection) {
            await connection.end();
        }
    }
}

async function fetchData(conn, table, timeStart, timeEnd) {
    const sql = `SELECT game_name, tables, timestamp 
                 FROM ${table} 
                 WHERE timestamp BETWEEN ? AND ? 
                 ORDER BY id ASC`;

    const [rows] = await conn.execute(sql, [timeStart, timeEnd]);

    const data = {
        labels: [],
        game_name: [],
        tables: []
    };

    rows.forEach(row => {
        const formattedTimestamp = moment(row.timestamp).local().format('YYYY-MM-DD hh:mm A');
        data.labels.push(formattedTimestamp);
        data.game_name.push(row.game_name);
        data.tables.push(row.tables);
    });

    return data;
}

app.get('/fetch-data', async (req, res) => {
 const startdate = req.query.startdate; 
const enddate = req.query.enddate;

if (!startdate) {
    return res.status(400).json({ error: 'Missing startdate parameter.' });
}

let timeStart, timeEnd;

if (!enddate) {
    const selectedDate = moment.tz(startdate, 'YYYY-MM-DD HH:mm', 'America/Chicago').startOf('day');
    const selectedEndDate =moment.tz(startdate, 'YYYY-MM-DD HH:mm', 'America/Chicago').endOf('day').hour(23).minute(45);
    timeStart = selectedDate.format('YYYY-MM-DD HH:mm');
    timeEnd = selectedEndDate.format('YYYY-MM-DD HH:mm');
} else {
    const selectedStartDate = moment.tz(startdate, 'YYYY-MM-DD HH:mm', 'America/Chicago');
    const selectedEndDate = moment.tz(enddate, 'YYYY-MM-DD HH:mm', 'America/Chicago').add(15, 'minutes');

    timeStart = selectedStartDate.format('YYYY-MM-DD HH:mm');
    timeEnd = selectedEndDate.format('YYYY-MM-DD HH:mm');
}

let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        const eplData = await fetchData(connection, 'poker_wait_list_epl', timeStart, timeEnd);
        const competitorData = await fetchData(connection, 'poker_wait_list_competitor', timeStart, timeEnd);

        res.json({
            EPL: eplData,
            Competitor: competitorData,
        });
    } catch (err) {
        console.error('Database Error:', err.message);
        res.status(500).json({ error: 'Database connection failed.' });
    } finally {
        if (connection) {
            await connection.end();
        }
    }
});

function logTime(taskName) {
    const currentTime = moment().tz('America/Chicago').format('YYYY-MM-DD HH:mm:ss');
    openUrl('https://pokeratlas.com/poker-room/texas-card-house-rio-grande-valley-edinburg/cash-games', 'poker_wait_list_competitor');
    openUrl('https://pokeratlas.com/poker-room/elite-poker-lounge-mcallen/cash-games', 'poker_wait_list_epl');
    console.log(`[${taskName}] Executing at: ${currentTime}`);
}

async function fetchAndExportData(tableName, connection,filePath, timeStart, timeEnd) {
    try {
        const data = await fetchData(connection, tableName, timeStart, timeEnd);

        const csvData = data.labels.map((label, index) => ({
            game_name: data.game_name[index],
            tables: data.tables[index],
            timestamp: moment(label, 'YYYY-MM-DD hh:mm A').format('YYYY-MM-DD HH:mm:ss'),
        }));

        const csv = parse(csvData, {
            fields: ['game_name', 'tables', 'timestamp'],
        });

        fs.writeFileSync(filePath, csv);
        console.log(`CSV file has been written to ${filePath}`);
    } catch (error) {
        console.error('Error fetching or exporting data:', error);
    }
}





async function uploadCsvToDbfs(localFilePath, dbfsPath) {
    try {
        if (!fs.existsSync(localFilePath)) {
            console.error(`File not found: ${localFilePath}`);
            return;
        }
        const fileContent = fs.readFileSync(localFilePath, { encoding: "base64" });
        const apiUrl = `${process.env.DATABRICKS_INSTANCE}`;
        if (!process.env.DATABRICKS_INSTANCE) {
            console.error("Databricks instance URL is not defined. Set the DATABRICKS_INSTANCE environment variable.");
            return;
        }
        const payload = {
            path: dbfsPath,
            overwrite: true,
            contents: fileContent
        };
        const headers = {
            "Authorization": `Bearer ${process.env.ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        };
        const response = await axios.post(apiUrl, payload, { headers });
        if (response.status === 200) {
            console.log("File uploaded successfully!");
            deleteLocalFile(localFilePath);
        } else {
            console.error(`Failed to upload file: ${response.status}`, response.data);
        }
    } catch (error) {
        console.error("Error uploading file:", error);
    }
}


async function pushtodbfs(EPL_PATH, TCH_PATH, DBFS_PATH_EPL, DBFS_PATH_TCH) {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        const startDate = moment().tz('America/Chicago').startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = moment().tz('America/Chicago').endOf('day').hour(23).minute(45).second(0).format('YYYY-MM-DD HH:mm:ss');

        await fetchAndExportData('poker_wait_list_epl', connection, EPL_PATH, startDate, endDate);
        await fetchAndExportData('poker_wait_list_competitor', connection, TCH_PATH, startDate, endDate);

        await uploadCsvToDbfs(EPL_PATH, DBFS_PATH_EPL);
        await uploadCsvToDbfs(TCH_PATH, DBFS_PATH_TCH);
    } catch (err) {
        console.error("Error during process:", err.stack || err);
    } finally {
        if (connection) {
            await connection.end();
            console.log("Database connection closed.");
        }
    }
}

async function deleteLocalFile(filePath) {
    try {
        await fs.promises.unlink(filePath);
        console.log(`File deleted successfully: ${filePath}`);
    } catch (err) {
        console.error(`Error deleting the file: ${filePath}`, err.stack || err);
    }
}

cron.schedule('45 23 * * *', () => {
    const today = moment().tz('America/Chicago').format('MM-DD-YYYY');
    const PokerWaitListEplName = `epl_${today}.csv`;
    const PokerWaitListCompetitorName = `tch_${today}.csv`;
    const EPL_PATH = path.join(uploadDir, PokerWaitListEplName);
    const TCH_PATH = path.join(uploadDir, PokerWaitListCompetitorName);
    const currentYear = moment().tz('America/Chicago').format('YYYY');
    const DBFS_PATH_EPL = `/FileStore/tables/EPL/EPL_Table_count/${currentYear}/${PokerWaitListEplName}`;
    const DBFS_PATH_TCH = `/FileStore/tables/EPL/TCH_Table_count/${currentYear}/${PokerWaitListCompetitorName}`;

     pushtodbfs(EPL_PATH, TCH_PATH, DBFS_PATH_EPL, DBFS_PATH_TCH);
    console.log("Daily DBFS task executed.");
}, {
    timezone: 'America/Chicago'
});

cron.schedule('5,35 0-23 * * *', () => {
    logTime('Task Running');
}, {
    timezone: 'America/Chicago'
});

app.get('/pickupdata-trigger', async() => {
    await sendFailureEmail("testing nodemailer");
});

// Function to round timestamp to the nearest 30-minute mark
const roundToNearest30Min = (timestamp) => {
    const minutes = moment(timestamp).minutes();
    const rounded = moment(timestamp).startOf("hour");

    if (minutes >= 45) {
        rounded.add(1, "hour"); // Round up to the next hour
    } else if (minutes >= 15) {
        rounded.add(30, "minutes"); // Round to :30
    }
    return rounded;
};

const checkMissingIntervals = async () => {
    const conn = await mysql.createConnection(dbConfig);
    try {
        console.log("Checking for missing intervals in both tables...");

        const startTime = moment().startOf("day"); // 12:00 AM
        const endTime = moment().tz("America/Chicago").hour(23).minute(30); // 11:30 PM

        let missingIntervalsByTable = {};

        for (let table of tablesToCheck) {
            console.log(`Checking table: ${table}`);

            // Fetch data using fetchData function
            const data = await fetchData(conn, table, startTime.format(), endTime.format());

            // Convert timestamps & round to the nearest 30-min mark
            const dbTimestamps = data.labels.map(time =>
                roundToNearest30Min(moment(time, "YYYY-MM-DD hh:mm A")).format("YYYY-MM-DD HH:mm")
            );

            // Generate expected 30-minute intervals
            let missingIntervals = [];
            let current = startTime.clone();

            while (current.isBefore(endTime) || current.isSame(endTime)) {
                const expectedTimestamp = current.format("YYYY-MM-DD HH:mm");

                // Check if the expected timestamp exists in the rounded DB timestamps
                if (!dbTimestamps.includes(expectedTimestamp)) {
                    missingIntervals.push(moment(current).format("YYYY-MM-DD hh:mm A"));
                }

                current.add(30, "minutes"); // Move to next 30-min interval
            }

            if (missingIntervals.length > 0) {
                missingIntervalsByTable[table] = missingIntervals;
            }
        }


        if (Object.keys(missingIntervalsByTable).length > 0) {
            console.log("Missing intervals found! Sending notification...");
            let emailBody = "The following 30-minute intervals are missing:\n\n";

            for (const [table, missingIntervals] of Object.entries(missingIntervalsByTable)) {
                emailBody += `Table: ${table}\n${missingIntervals.join("\n")}\n\n`;
            }
            await sendFailureEmail(emailBody);
        } else {
            console.log("No missing intervals found.");
        }

    } catch (error) {
        console.error("Error checking missing intervals:", error);
    } finally {
        conn.end();
    }
};

// Schedule Cron Job at 11:50 PM
cron.schedule("40 23 * * *", () => {
    console.log("Running cron job at 11:50 PM...");
    checkMissingIntervals();
}, {
    timezone: "America/Chicago",
});



const port = process.env.SERVER_PORT;
const sslServer = http.createServer({},app);

sslServer.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

