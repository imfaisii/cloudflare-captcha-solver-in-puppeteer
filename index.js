import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import path from 'path'
import wildcardMatch from 'wildcard-match'
import cheerio from 'cheerio'
import xlsx from "json-as-xlsx"
import moment from 'moment'
import fs from 'fs'
import readline from 'node:readline'
import reader from 'xlsx'
import randomstring from "randomstring"
import { TimeoutError } from 'puppeteer'

// functions
const baseUrl = "https://turquoise.health"
const blockRequest = wildcardMatch(['*.css', '*.js'], { separator: false })
const cl = message => console.log(message)
const sleep = ms => new Promise(r => setTimeout(r, ms))

let $ = ''
let sessionId = randomstring.generate({
  length: 7,
  charset: 'alphabetic'
});

let data = {
  hospitals: [],
}

const exportHospitals = () => {
  xlsx([{
    sheet: "Hospitals",
    columns: [
      { label: "name", value: 'name' },
      { label: "url", value: 'url' },
    ],
    content: data.hospitals,
  }], {
    fileName: "Data-Hospitals",
    extraLength: 10,
  })
}

function toLowerKeys(obj) {
  return Object.keys(obj).reduce((accumulator, key) => {
    accumulator[key.toLowerCase()] = obj[key];
    return accumulator;
  }, {});
}

const readHospitalsExcelFile = async () => {
  // Reading our test file
  const file = reader.readFile('./Data-Hospitals.xlsx')

  let data = []

  const sheets = file.SheetNames

  for (let i = 0; i < sheets.length; i++) {
    const temp = reader.utils.sheet_to_json(
      file.Sheets[file.SheetNames[i]])
    temp.forEach((res) => {
      data.push(toLowerKeys(res))
    })
  }

  return data;
}

const watchRequestsToBlock = page => {

  page.setRequestInterception(true);

  page.on('request', (request) => {

    if (blockRequest(request.url())) {
      const u = request.url()

      if (u.includes("challenges.css")) {
        console.log(`Request to ${u}.. is aborted`)

        request.abort()

        return true;
      }
    }

    request.continue();
  })
}

const watchForCaptcha = page => {
  page.on('domcontentloaded', async () => {

    if (await page.$('#challenge-body-text') !== null) {
      cl("Waiting for captcha to load...")

      const elementHandle = await page.waitForSelector('.hcaptcha-box iframe').catch((e) => cl(e))
      const title = await page.$eval("iframe", element => element.getAttribute("title"))

      if (title.includes('Cloudflare')) {

        await solveClouflareCaptacha(elementHandle, page)

        await sleep(5000)

      } else {

        await page.reload();

        // cl("Not solving to avoid credits loss.")

        // await solveHcaptchaProblem()
      }
    }
  });

}

const getDoneHospitals = async () => {
  const fileStream = fs.createReadStream('done.txt');
  let doneHospitals = []

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const hospital of rl) {
    doneHospitals.push(hospital)
  }

  return doneHospitals;
}

const scrapLatestHospital = async (page) => {
  do {
    await page.waitForSelector('.alphabet-wise-names').catch((e) => cl(e))
    $ = cheerio.load(await page.content());
    let pageNo = $(".alphabet-pagination > ul > li:last-child").find('a').attr('href')

    // get insital links and names
    $('.alphabet-wise-names > ul > li').each(function () {
      data.hospitals.push({
        name: $(this).find('a').text(),
        url: baseUrl + $(this).find('a').attr('href')
      })
    });

    await page.goto(`${baseUrl}/providers${pageNo}`)
    cl(`Scrapped ${pageNo !== undefined ? pageNo.replace("?page=", "") : '220'}/220`)
  } while ($(".alphabet-pagination > ul > li:last-child").find('a').attr('href') !== undefined)
  // export hospitals
  exportHospitals();
  cl("Exported hospitals file.")
}


const solveClouflareCaptacha = async (elementHandle, page) => {
  cl("Captcha type => cloudFlare")
  cl("WAITING FOR 10 SECONDS TO GET CHECKBOX LOADED...")

  await sleep(10000)

  $ = cheerio.load(await page.content())

  const frame = await elementHandle.contentFrame();

  await frame.waitForSelector('input[type="checkbox"]').catch((e) => cl(e))
  await frame.click('input[type="checkbox"]');
}

const solveHcaptchaProblem = async () => {
  cl("Captcha type => hCaptcha")
  cl("Waiting for hcaptcha solver...")

  await page.waitForSelector('.captcha-solver').catch((e) => cl(e))
  await page.waitForSelector(`.captcha-solver[data-state="solved"]`, { timeout: 150000 }).catch((e) => cl(e))
}

const main = async () => {
  const pathToExtension = path.join(path.resolve(), '2captcha-solver');

  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({
    headless: false,
    // headless: false,
    args: [
      `--disable-extensions-except=${pathToExtension}`,
      `--load-extension=${pathToExtension}`,
    ],
  });

  const [page] = await browser.pages()

  watchRequestsToBlock(page)
  // watchForCaptcha(page)

  await page.goto(baseUrl + '/providers')

  cl("Waiting for captcha to load...")

  const elementHandle = await page.waitForSelector('.hcaptcha-box iframe').catch((e) => cl(e))
  const title = await page.$eval("iframe", element => element.getAttribute("title"))

  if (title.includes('Cloudflare')) {

    await solveClouflareCaptacha(elementHandle, page)

    await sleep(5000)

  } else {

    await page.reload();

    // cl("Not solving to avoid credits loss.")

    // await solveHcaptchaProblem()
  }

  // scrapping all the hospitals only if you want to get latest hospitals scrapping
  // await scrapLatestHospital()

  // to read hospitals from file
  data.hospitals = await readHospitalsExcelFile()

  for await (const h of data.hospitals) {
    let hospitalsDone = await getDoneHospitals()

    if (!hospitalsDone.includes(h.name) || (hospitalsDone.pop() == h.name)) {
      cl(`${h.name} is being scrapped.`)
      await page.goto(h.url)
      await page.waitForSelector('.hospital-all-detail > ul > li', { timeout: 0 }).catch((e) => cl(e))

      $ = cheerio.load(await page.content())
      let hospitalIndex = undefined
      let additonalDetails = {}
      let services = []

      cl(`Getting Additional Details...`)

      $(".hospital-all-detail > ul > li").each(function () {
        additonalDetails[$(this).find("p").text().replace(/\s+/g, '_').toLowerCase()] = $(this).find("span").text().trim()
      })

      $(".hospital-clinical-services > ul > li").each(function () {
        services.push($(this).text())
      })

      hospitalIndex = data.hospitals.map((e) => e.name).indexOf(additonalDetails.name)

      if (hospitalIndex !== undefined && hospitalIndex > 0) {
        data.hospitals[hospitalIndex].additonal_details = additonalDetails
        data.hospitals[hospitalIndex].services = services

        await page.goto(h.url.replace("/information", ""))
        await page.waitForSelector('.browse-services > ul > li').then(async () => {
          $ = cheerio.load(await page.content())

          cl(`Getting Provider Services Details...`)

          let providerSevices = []

          $(".browse-services > ul > li").each(function () {
            const e = $(this).find("a")

            providerSevices.push({
              name: e.find("p").text(),
              url: baseUrl + e.attr("href"),
            })

          })

          cl(`Getting Estimations...`)
          let estimations = []

          for await (const p of providerSevices) {
            await page.goto(p.url)
            await page.waitForSelector('.browse-services > ul > li').catch((e) => cl(e))
            $ = cheerio.load(await page.content())

            $(".browse-services > ul > li").each(function () {
              const e = $(this).find("a")

              if (!$(this).find('.service-info-cont').length) {
                providerSevices.push({
                  name: e.find("p").text(),
                  url: baseUrl + e.attr("href"),
                })
              } else {
                estimations.push({
                  service_code: $(this).find(".service-code").text(),
                  details: $(this).find("p").text(),
                  price: $(this).find("h5").text() ?? '',
                  title: $("#provider-services > div > div > div.browse-titie_sec > div > h2").text(),
                  pricePage: p.url
                })

              }
            })
            providerSevices = providerSevices.filter((e) => e.url != p.url)
          }

          for await (const p of providerSevices) {
            await page.goto(p.url)
            await page.waitForSelector('.browse-services > ul > li').catch((e) => cl(e))
            $ = cheerio.load(await page.content())

            $(".browse-services > ul > li").each(function () {
              const e = $(this).find("a")

              if (!$(this).find('.service-info-cont').length) {
                providerSevices.push({
                  name: e.find("p").text(),
                  url: baseUrl + e.attr("href"),
                })
              } else {
                estimations.push({
                  service_code: $(this).find(".service-code").text(),
                  details: $(this).find("p").text(),
                  price: $(this).find("h5").text() ?? '',
                  title: $("#provider-services > div > div > div.browse-titie_sec > div > h2").text(),
                  pricePage: p.url
                })

              }
            })
            providerSevices = providerSevices.filter((e) => e.url != p.url)
          }


          for await (const p of providerSevices) {
            await page.goto(p.url)
            await page.waitForSelector('.browse-services > ul > li').catch((e) => cl(e))
            $ = cheerio.load(await page.content())

            $(".browse-services > ul > li").each(function () {
              const e = $(this).find("a")
              estimations.push({
                service_code: $(this).find(".service-code").text(),
                details: $(this).find("p").text(),
                price: $(this).find("h5").text() ?? '',
                title: $("#provider-services > div > div > div.browse-titie_sec > div > h2").text(),
                pricePage: p.url
              })
            })
          }

          cl("Hospital Index")
          cl(hospitalIndex)
          providerSevices[0].estimations = estimations
          data.hospitals[hospitalIndex].provider_services = providerSevices

          fs.appendFileSync('done.txt', h.name + "\n");
          hospitalsDone = await getDoneHospitals()

          cl(`Exporting...`)

          let resultant = [];
          let estimationsNew = [];

          data.hospitals.forEach(function (hospital, index) {
            if (hospitalsDone.includes(hospital.name)) {
              if (hospital?.provider_services) {
                hospital.provider_services.forEach(providerService => {
                  if (providerService?.estimations) {
                    providerService.estimations.forEach(est => {
                      estimationsNew.push({
                        hospitalUrl: hospital.url,
                        hospitalName: hospital.name,
                        hospitalDetails: hospital.additonal_details,
                        serviceName: providerService.name,
                        serviceUrl: providerService.url,
                        serviceCode: est.service_code,
                        details: est.details,
                        price: est.price,
                        title: est.title,
                        pricePage: est.pricePage
                      })
                    })
                  }
                })
              }
              resultant.push({
                hospitalName: hospital.name,
                estimations: estimationsNew
              })

              estimationsNew = []
            }
          });

          let sheets = [];
          let sheetName = ''
          let name = " -" + randomstring.generate({
            length: 2,
            charset: 'alphabetic'
          })
          resultant.forEach((ele) => {
            if (ele.estimations.length > 0) {
              sheetName = ele.hospitalName.substr(0, 25) + name
              sheets.push({
                sheet: sheetName.replace(/[^a-zA-Z ]/g, ""),
                columns: [
                  { label: "Service Name", value: 'title' },
                  { label: "Service Code", value: 'serviceCode' },
                  { label: "Service Price", value: 'price' },
                  { label: "Page URL", value: 'pricePage' },
                  { label: "Service Details", value: 'details' },
                  { label: "Service URL", value: 'serviceUrl' },
                  { label: "Hospital Name", value: 'hospitalName' },
                  { label: "Hospital Site", value: 'hospitalUrl' },
                  { label: "Hospital Address", value: (row) => row.hospitalDetails.address },
                  { label: "Hospital Phone", value: (row) => row.hospitalDetails.phone },
                  { label: "Medicare Provider ID", value: (row) => row.hospitalDetails.medicare_provider_id },
                  { label: "National Provider ID", value: (row) => row.hospitalDetails['national_provider_id_(npi)'] },
                  { label: "Ownership", value: (row) => row.hospitalDetails.ownership },
                  { label: "Beds", value: (row) => row.hospitalDetails.beds },
                  { label: "Hospital Address", value: (row) => row.hospitalDetails.address },
                ],
                content: ele.estimations,
              })
            }
          })

          let settings = {
            fileName: "Data-" + sessionId + '-' + moment().format('DD-MM-YYYY'),
            extraLength: 10,
          }

          xlsx(sheets, settings)

        }).catch(e => {
          if (e.message.includes('Waiting for selector')) {
            console.log(`FAILED Timeout ${h.name}`);
            fs.appendFileSync('done.txt', h.name + "\n");
          } else {
            console.log(`FAILED invalid name ${h.name}`);
            fs.appendFileSync('failed.txt', h.name + "\n");
          }
          console.log(e);
        });
      }
    }
    else {
      fs.appendFileSync('skipped.txt', h.name + "\n");
    }
  }

  cl("Scrapping completed... :)")
  await browser.close();
}

main()