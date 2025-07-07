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
const nodemailer = require("nodemailer");
require("dotenv").config();
const allowedOrigins = ['*'];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
const dbConfig = {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB,
};


const uploadDir = path.join(__dirname, 'upload');

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'table.html'));
});


puppeteer.use(StealthPlugin());

//puppeteer functions
const ScrapData = async (url, retriesLeft = 8) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true, // Set to true for production
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

        if (retriesLeft > 0) {
            console.warn(`Timeout occurred. Relaunching browser... (${retriesLeft} retries left)`);
            return await ScrapData(url, retriesLeft - 1); // Relaunch Puppeteer & retry
        }else{
                    const failureTime = moment().tz("America/Chicago").format("YYYY-MM-DD hh:mm A z");
                    const data = `Scraping failed for URL: ${url} after multiple retries.\nFailure Time: ${failureTime}`
                    await sendEmail(data);
                }

        return [];
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};


// database functions
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
		const roundedTimestamp = roundToNearest30Min(timestamp);                
                const query = `INSERT INTO ${tableName} (game_name, tables, waiting, timestamp) VALUES (?, ?, ?, ?)`;

                try {
                    await connection.execute(query, [gameName, tables, waiting, roundedTimestamp]);
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
                 ORDER BY timestamp ASC`;

    const [rows] = await conn.execute(sql, [timeStart, timeEnd]);

    const data = {
        labels: [],
        game_name: [],
        tables: []
    };

    rows.forEach(row => {
	const roundedTimestamp = roundToNearest30Min(row.timestamp);
        const formattedTimestamp = moment(roundedTimestamp).local().format('YYYY-MM-DD hh:mm A');
        data.labels.push(formattedTimestamp);
        data.game_name.push(row.game_name);
        data.tables.push(row.tables);
    });

    return data;
}

function logTime(taskName) {
    const currentTime = moment().tz('America/Chicago').format('YYYY-MM-DD HH:mm:ss');
    openUrl('https://pokeratlas.com/poker-room/texas-card-house-rio-grande-valley-edinburg/cash-games', 'poker_wait_list_competitor');
    openUrl('https://pokeratlas.com/poker-room/elite-poker-lounge-mcallen/cash-games', 'poker_wait_list_epl');
    console.log(`[${taskName}] Executing at: ${currentTime}`);
}
//mailer functions
const sendEmail = async (data) => {
    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.FROM_EMAIL,
                pass: process.env.APP_PASS, 
            },
        });

        const mailOptions = {
            from: process.env.FROM_EMAIL,
            to: process.env.TO_EMAIL,
            subject: "EPL ANALYTICS: Alert",
            text: `${data}`,
        };

        await transporter.sendMail(mailOptions);

        console.log(`Notification email sent at ${data}`);
    } catch (emailError) {
        console.error("Error sending email:", emailError);
    }
};

function roundToNearest30Min(timestamp) {
    var time = moment(timestamp, 'YYYY-MM-DD HH:mm:ss');
    var roundedTime = time.clone().startOf('minute');
    var minutes = roundedTime.minutes();
    var roundedMinutes = Math.round(minutes / 30) * 30;
    roundedTime.minutes(roundedMinutes).seconds(0);
    return roundedTime.format('YYYY-MM-DD HH:mm:ss');
}

const tablesToCheck = ["poker_wait_list_epl", "poker_wait_list_competitor"]; 
const checkMissingIntervals = async () => {
    const conn = await mysql.createConnection(dbConfig);
    try {
        console.log("Checking for missing intervals in both tables...");

        const startTime = moment().tz("America/Chicago").startOf("day");
        const endTime = moment().tz("America/Chicago").hour(23).minute(45);

        // const startTime = moment("2025-02-13 00:00");  
        // const endTime = moment("2025-02-13 23:45");
        
        let missingIntervalsByTable = {};

        for (let table of tablesToCheck) {
            console.log(`Checking table: ${table}`);
            const data = await fetchData(conn, table, startTime.format("YYYY-MM-DD HH:mm:ss"), endTime.format("YYYY-MM-DD HH:mm:ss"));

	    const dbTimestamps = data.labels.map(time => moment(time, 'YYYY-MM-DD hh:mm A').format("YYYY-MM-DD HH:mm:ss"));

            let missingIntervals = [];
            let current = startTime.clone();

            while (current.isBefore(endTime) || current.isSame(endTime)) {
                const expectedTimestamp = current.format("YYYY-MM-DD HH:mm:ss");

                if (!dbTimestamps.includes(expectedTimestamp)) {
                    missingIntervals.push(current.format("YYYY-MM-DD hh:mm A"));
                }

                current.add(30, "minutes"); 
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
         
            await sendEmail(emailBody);
            // console.log(emailBody)
        } else {
            console.log("No missing intervals found.");
        }

    } catch (error) {
        console.error("Error checking missing intervals:", error);
    } finally {
        conn.end();
    }
};

//databricks functions
async function fetchAndExportData(tableName, connection,filePath, timeStart, timeEnd) {
    try {
        const data = await fetchData(connection, tableName, timeStart, timeEnd);

         const csvData = data.labels.map((label, index) => {
            const rawTimestamp = moment(label, 'YYYY-MM-DD hh:mm A').format('YYYY-MM-DD HH:mm');

            return {
                game_name: data.game_name[index],
                tables: data.tables[index],
                timestamp: rawTimestamp,
            };
        });

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

app.get('/fetch-data', async (req, res) => {
 const startdate = req.query.startdate; 
const enddate = req.query.enddate;

if (!startdate) {
    return res.status(400).json({ error: 'Missing startdate parameter.' });
}

let timeStart, timeEnd;

if (!enddate) {
    const selectedDate = moment.tz(startdate, 'YYYY-MM-DD HH:mm', 'America/Chicago').startOf('day').hour(9).minute(30);
    const selectedEndDate =moment.tz(startdate, 'YYYY-MM-DD HH:mm', 'America/Chicago').add(1, 'day').startOf('day').hour(6).minute(45);
    timeStart = selectedDate.format('YYYY-MM-DD HH:mm');
    timeEnd = selectedEndDate.format('YYYY-MM-DD HH:mm');
} else {
    const selectedStartDate = moment.tz(startdate, 'YYYY-MM-DD HH:mm', 'America/Chicago').startOf('day').hour(9).minute(30);
    const selectedEndDate = moment.tz(enddate, 'YYYY-MM-DD HH:mm', 'America/Chicago').add(1, 'day').startOf('day').hour(6).minute(45);

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




//cron functions
cron.schedule('5,35 0-23 * * *', () => {
    logTime('Task Running');
}, {
    timezone: 'America/Chicago'
});

cron.schedule('45 23 * * *', () => {
    checkMissingIntervals();
    console.log("Checking and reporting missing intervals...");
}, {
    timezone: 'America/Chicago'
});


cron.schedule('50 23 * * *', () => {
    const today = moment().tz('America/Chicago').format('MM-DD-YYYY');
    const PokerWaitListEplName = `epl_${today}.csv`;
    const PokerWaitListCompetitorName = `tch_${today}.csv`;
    const EPL_PATH = path.join(uploadDir, PokerWaitListEplName);
    const TCH_PATH = path.join(uploadDir, PokerWaitListCompetitorName);
    const currentMonth = moment().tz('America/Chicago').format('MMMM');
    const currentYear = moment().tz('America/Chicago').format('YYYY');
    const DBFS_PATH_EPL = `/FileStore/tables/EPL/EPL_Table_count/${currentYear}/${currentMonth}/${PokerWaitListEplName}`;
    const DBFS_PATH_TCH = `/FileStore/tables/EPL/TCH_Table_count/${currentYear}/${currentMonth}/${PokerWaitListCompetitorName}`;

     pushtodbfs(EPL_PATH, TCH_PATH, DBFS_PATH_EPL, DBFS_PATH_TCH);
    console.log("Daily DBFS task executed.");
}, {
    timezone: 'America/Chicago'
});



//testing triggers
// app.get('/pickupdata-trigger', () => {
//      checkMissingIntervals();
// });

//server configs
const port = process.env.SERVER_PORT;
const sslServer = http.createServer(
   app
);

sslServer.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

